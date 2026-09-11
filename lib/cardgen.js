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
    if (/^(34|37)/.test(b)) return { name: "amex", label: "AMEX", length: 15, cvcLen: 4, prefix: "34/37", lengths: [15] };
    if (/^4/.test(b)) return { name: "visa", label: "VISA", length: 16, cvcLen: 3, prefix: "4", lengths: [16, 13, 19] };
    if (/^(5[1-5]|2[2-7])/.test(b)) return { name: "mastercard", label: "MASTERCARD", length: 16, cvcLen: 3, prefix: "51-55|22-27", lengths: [16, 19] };
    if (/^(65|6011|622[1-9]|64[4-9])/.test(b)) return { name: "discover", label: "DISCOVER", length: 16, cvcLen: 3, prefix: "6011|65|64|622", lengths: [16, 19] };
    if (/^(30[0-5]|3095|36|38|39)/.test(b)) return { name: "diners", label: "DINERS", length: 14, cvcLen: 3, prefix: "30/36/38/39", lengths: [14, 16, 19] };
    if (/^35/.test(b)) return { name: "jcb", label: "JCB", length: 16, cvcLen: 3, prefix: "35", lengths: [16, 17, 18, 19] };
    if (/^62/.test(b)) return { name: "unionpay", label: "UNIONPAY", length: 16, cvcLen: 3, prefix: "62", lengths: [16, 17, 18, 19] };
    if (/^(50|56|57|58|6304|6759|676[1-3])/.test(b)) return { name: "maestro", label: "MAESTRO", length: 16, cvcLen: 3, prefix: "50|56-58|6304|6759|676", lengths: [12, 13, 14, 15, 16, 17, 18, 19] };
    return { name: "generic", label: "CARD", length: 16, cvcLen: 3, prefix: "", lengths: [16, 19] };
  }

  function cardSpec(bin) {
    return detectScheme(bin);
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
    let length = opts && opts.length ? opts.length : scheme.length;
    if (opts && opts.length && scheme.lengths && scheme.lengths.indexOf(opts.length) === -1) {
      length = scheme.length;
    }
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
      schemeLabel: scheme.label,
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
    cardSpec: cardSpec,
    expString: expString
  };
})();