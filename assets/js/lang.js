/* AEEC — seçilmiş dilin yadda saxlanması.
   Ziyarətçi əvvəllər EN və ya RU seçibsə və sayta kənardan əsas ünvanla (/) daxil olursa,
   həmin dilin ana səhifəsinə yönləndirilir. Birbaşa açılan digər səhifələrin dili dəyişdirilmir. */
(function () {
  try {
    var p = localStorage.getItem('aeec-lang');
    var first = !sessionStorage.getItem('aeec-entry');
    sessionStorage.setItem('aeec-entry', '1');
    if ((p === 'en' || p === 'ru') && first) {
      var r = document.referrer;
      if (!r || r.indexOf(location.origin + '/') !== 0) location.replace('/' + p + '/' + location.hash);
    }
  } catch (e) {}
})();
