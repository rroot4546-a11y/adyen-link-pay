(function () {
  "use strict";

  function luhnSum(digits, fullLen) {
    const parity = fullLen % 2;
    let sum = 0;
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

  function mod10CheckDigit(panWithoutCheck, totalLen) {
    const sum = luhnSum(panWithoutCheck, totalLen);
    return ((10 - (sum % 10)) % 10);
  }

  function randomDigits(n) {
    let out = "";
    for (let i = 0; i < n; i++) {
      out += String(Math.floor(Math.random() * 10));
    }
    return out;
  }

  function detectScheme(bin) {
    const b = String(bin).replace(/\D/g, "");
    if (/^3[47]/.test(b)) return { name: "amex", length: 15, cvcLen: 4, prefix: "34|37" };
    if (/^4/.test(b)) return { name: "visa", length: 16, cvcLen: 3, prefix: "4" };
    if (/^5[1-5]/.test(b)) return { name: "mastercard", length: 16, cvcLen: 3, prefix: "51-55" };
    if (/^2[2-7]/.test(b)) return { name: "mastercard-2series", length: 16, cvcLen: 3, prefix: "22-27" };
    if (/^6/.test(b)) return { name: "discover", length: 16, cvcLen: 3, prefix: "6" };
    if (/^3[068]/.test(b)) return { name: "diners", length: 14, cvcLen: 3, prefix: "30|36|38" };
    return { name: "generic", length: 16, cvcLen: 3, prefix: "" };
  }

  function genCardNumber(bin, totalLen) {
    let digits = String(bin).replace(/\D/g, "");
    const totalLength = totalLen || 16;
    if (digits.length >= totalLength) digits = String(bin).slice(0, totalLength - 1);
    while (digits.length < totalLength - 1) digits += randomDigits(1);
    const checkDigit = mod10CheckDigit(digits, totalLength);
    return digits + String(checkDigit);
  }

  function randExpiry() {
    const now = new Date();
    const startYear = now.getFullYear();
    const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
    const year = startYear + (Math.floor(Math.random() * 6) + 1);
    return {
      month: month,
      expMonth: month,
      year: String(year),
      fullYear: String(year),
      shortYear: String(year).slice(-2)
    };
  }

  function genCVC(length) {
    return randomDigits(length || 3);
  }

  function genCard(bin, opts) {
    const cleanBin = String(bin).replace(/\D/g, "");
    const scheme = detectScheme(cleanBin);
    const length = opts && opts.length ? opts.length : scheme.length;
    const cvcLen = opts && opts.cvcLen ? opts.cvcLen : scheme.cvcLen;
    const exp = randExpiry();
    const number = genCardNumber(cleanBin, length);
    return {
      number: number,
      expiryMonth: exp.month,
      expiryYear: exp.fullYear,
      expMonth: exp.month,
      expYear: exp.fullYear,
      expShort: exp.shortYear,
      cvc: genCVC(cvcLen),
      cvcLen: cvcLen,
      bin: cleanBin,
      scheme: scheme.name,
      len: number.length + "-digits",
      luhnPass: luhnSum(number, number.length) % 10 === 0
    };
  }

  function isValidLuhn(num) {
    const digits = String(num).replace(/\D/g, "");
    return luhnSum(digits, digits.length) % 10 === 0;
  }

  function expString(card, format) {
    if (format === "slashed") return card.expMonth + "/" + card.expShort;
    return card.expMonth + card.expShort;
  }

  window.CardGen = {
    genCard: genCard,
    isValidLuhn: isValidLuhn,
    genNumber: genCardNumber,
    genExpiry: randExpiry,
    genCvc: genCVC,
    detectScheme: detectScheme,
    expString: expString
  };
})();