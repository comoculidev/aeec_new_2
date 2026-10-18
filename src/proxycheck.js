'use strict';
// Detects a wrong reverse-proxy setup: if the address the server sees for a visitor belongs to
// Cloudflare (or is the local Apache itself), every visitor would share one address and the login
// limits would block everybody at once. Ranges: https://www.cloudflare.com/ips/ (checked 2026-10).
const net = require('node:net');
const list = new net.BlockList();
for (const r of ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22']) { const [a, p] = r.split('/'); list.addSubnet(a, +p, 'ipv4'); }
for (const r of ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32']) { const [a, p] = r.split('/'); list.addSubnet(a, +p, 'ipv6'); }
function proxyProblem(ip) {
  if (!ip) return 'Ziyarətçinin ünvanı müəyyən edilmədi';
  try { if (list.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4')) return 'Server ziyarətçinin yerinə Cloudflare ünvanını görür (Apache-də mod_remoteip qurulmayıb)'; } catch { /* ignore */ }
  if (/^(127\.|::1$)/.test(ip)) return 'Server ziyarətçinin yerinə Apache-nin öz ünvanını görür (.env-də TRUST_PROXY=1 və Apache-də X-Real-IP lazımdır)';
  return '';
}
module.exports = { proxyProblem };
