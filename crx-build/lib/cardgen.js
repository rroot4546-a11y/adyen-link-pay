(function () {
  "use strict";

  function luhnSum(digits) {
    let sum = 0;
    const parity = digits.length % 2;
    for (let i = 0; i < digits.length; i++) {
      let d = digits.charCodeAt(i) - 48;
      if (i % 2 === parity) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum;
  }

  function mod10CheckDigit(panWithoutCheck) {
    const sum = luhnSum(panWithoutCheck);
    return ((10 - (sum % 10)) % 10);
  }

  function genCardNumber(bin, length) {
    const totalLen = length || 16;
    const prefixLen = totalLen - 1;
    const prefix = bin + randomDigits(prefixLen - bin.length);
    const checkDigit = mod10CheckDigit(prefix);
    return prefix + String(checkDigit);
  }

  function randomDigits(n) {
    let out = "";
    for (let i = 0; i < n; i++) {
      out += String(Math.floor(Math.random() * 10));
    }
    return out;
  }

  function randExpiry() {
    const now = new Date();
    let year = now.getFullYear() + Math.floor(Math.random() * 4) + 1;
    let month = Math.floor(Math.random() * 12) + 1;
    const expMonth = String(month).padStart(2, "0");
    return {
      month: expMonth,
      year: String(year).slice(-2),
      fullYear: String(year)
    };
  }

  function genCVC(length) {
    const L = length || 3;
    return randomDigits(L);
  }

  function genCard(bin, opts) {
    const length = opts && opts.length ? opts.length : 16;
    const cvcLen = opts && opts.cvcLen ? opts.cvcLen : 3;
    const exp = randExpiry();
    return {
      number: genCardNumber(bin, length),
      expiryMonth: exp.month,
      expiryYear: exp.fullYear,
      cvc: genCVC(cvcLen),
      bin: bin
    };
  }

  function isValidLuhn(num) {
    return luhnSum(num) % 10 === 0;
  }

  window.CardGen = {
    genCard: genCard,
    isValidLuhn: isValidLuhn,
    genNumber: genCardNumber,
    genExpiry: randExpiry,
    genCvc: genCVC
  };
})();
