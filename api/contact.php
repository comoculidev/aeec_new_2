<?php
/**
 * AEEC — sorğu formalarını e-poçtla göndərən skript.
 * Tələb: serverdə PHP 7.4+ və işlək mail() (sendmail/postfix və ya SMTP relay).
 * Skript işləmirsə, sayt avtomatik olaraq ziyarətçinin e-poçt proqramını açır.
 * Göndərilən məlumat serverdə SAXLANILMIR (yalnız tezlik məhdudiyyəti üçün IP-nin heşi 10 dəqiqə saxlanılır).
 */
declare(strict_types=1);

const TO_EMAIL      = 'office@aeec.az';
const FROM_EMAIL    = 'no-reply@aeec.az';
const ALLOWED_HOSTS = ['aeec.az', 'www.aeec.az'];
const MIN_ELAPSED   = 2500;   // ms — bundan tez doldurulan forma bot sayılır
const RATE_MAX      = 5;      // bir IP-dən
const RATE_WINDOW   = 600;    // saniyə ərzində

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex');

function out(int $code, array $data): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function clean($v, int $max, bool $multiline = false): string
{
    if (!is_string($v)) {
        return '';
    }
    $v = preg_replace($multiline ? '/[^\P{C}\n\t]+/u' : '/\p{C}+/u', ' ', $v) ?? '';
    $v = trim($v);
    return function_exists('mb_substr') ? mb_substr($v, 0, $max, 'UTF-8') : substr($v, 0, $max);
}

function mime(string $s): string
{
    return '=?UTF-8?B?' . base64_encode($s) . '?=';
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    out(405, ['ok' => false, 'error' => 'method']);
}

// Sorğu yalnız saytın özündən gəlməlidir
$self   = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? '') ?? '');
$source = $_SERVER['HTTP_ORIGIN'] ?? ($_SERVER['HTTP_REFERER'] ?? '');
if ($source !== '') {
    $h = strtolower((string) parse_url($source, PHP_URL_HOST));
    if ($h !== $self && !in_array($h, ALLOWED_HOSTS, true)) {
        out(403, ['ok' => false, 'error' => 'origin']);
    }
}

$raw  = file_get_contents('php://input', false, null, 0, 20000);
$data = json_decode((string) $raw, true);
if (!is_array($data)) {
    $data = $_POST;
}

// Spam süzgəcləri: tələ sahəsi və doldurma müddəti (bota "uğurlu" cavab verilir, məktub göndərilmir)
if (clean($data['aeec_hp'] ?? '', 200) !== '' || (int) ($data['elapsed'] ?? 0) < MIN_ELAPSED) {
    out(200, ['ok' => true]);
}

$name    = clean($data['name'] ?? '', 120);
$email   = clean($data['email'] ?? '', 200);
$company = clean($data['company'] ?? '', 160);
$dir     = clean($data['direction'] ?? '', 160);
$course  = clean($data['course'] ?? '', 160);
$message = clean($data['message'] ?? '', 4000, true);
$lang    = in_array($data['lang'] ?? '', ['az', 'en', 'ru'], true) ? $data['lang'] : 'az';
$page    = clean($data['page'] ?? '', 200);
$form    = clean($data['form'] ?? '', 40);
$consent = ($data['consent'] ?? false) === true || ($data['consent'] ?? '') === 'on';

if ($name === '' || !$consent || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    out(422, ['ok' => false, 'error' => 'validation']);
}

// Tezlik məhdudiyyəti (Cloudflare arxasında ziyarətçinin həqiqi IP-si CF-Connecting-IP başlığındadır)
$ip   = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? ($_SERVER['REMOTE_ADDR'] ?? '0');
$file = rtrim(sys_get_temp_dir(), '/\\') . '/aeec_form_' . hash('sha256', $ip) . '.json';
$now  = time();
$hits = [];
if (is_file($file)) {
    $hits = json_decode((string) @file_get_contents($file), true);
    $hits = is_array($hits) ? array_values(array_filter($hits, static fn ($t) => is_int($t) && $t > $now - RATE_WINDOW)) : [];
}
if (count($hits) >= RATE_MAX) {
    out(429, ['ok' => false, 'error' => 'rate']);
}
$hits[] = $now;
@file_put_contents($file, json_encode($hits), LOCK_EX);

$lines = ['Ad, soyad: ' . $name, 'E-poçt: ' . $email];
if ($company !== '') { $lines[] = 'Şirkət: ' . $company; }
if ($dir !== '')     { $lines[] = 'İstiqamət: ' . $dir; }
if ($course !== '')  { $lines[] = 'Kurs: ' . $course; }
if ($message !== '') { $lines[] = ''; $lines[] = 'Mesaj:'; $lines[] = $message; }
$lines[] = '';
$lines[] = '—';
$lines[] = 'Forma: ' . ($form !== '' ? $form : '-') . ' · Dil: ' . strtoupper($lang) . ' · Səhifə: https://aeec.az' . $page;
$lines[] = 'Ziyarətçi fərdi məlumatlarının işlənməsinə razılıq verib.';
$body = implode("\r\n", $lines);

$subject = mime('AEEC sayt sorğusu — ' . $name . ' [' . strtoupper($lang) . ']');
$headers = implode("\r\n", [
    'From: ' . mime('AEEC sayt') . ' <' . FROM_EMAIL . '>',
    'Reply-To: ' . mime($name) . ' <' . $email . '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
]);

$sent = function_exists('mail') && @mail(TO_EMAIL, $subject, $body, $headers, '-f' . FROM_EMAIL);
if (!$sent) {
    out(502, ['ok' => false, 'error' => 'mail']);
}
out(200, ['ok' => true]);
