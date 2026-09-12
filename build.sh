#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ZIP=extension.zip
OUT=Adyen-Link-Auto-Pay.crx

rm -f "$ZIP"
zip -X -q -r "$ZIP" \
  background.js content.js icons lib manifest.json options popup proxy.js telegram.js \
  -x '*/.*'

node - <<'EOF'
const fs = require("fs");
const c = require("crypto");
const OUT = "Adyen-Link-Auto-Pay.crx";
const zip = fs.readFileSync("extension.zip");
const keyPem = fs.readFileSync("key.pem");

const priv = c.createPrivateKey(keyPem);
const spki = c.createPublicKey(priv).export({ type: "spki", format: "der" });
const crxid = c.createHash("sha1").update(spki).digest().slice(0, 16);
const sig = c.sign("sha256", zip, priv);              // PKCS1 v1.5 RSA-SHA256 over zip

fs.writeFileSync("sig.bin", sig);
fs.writeFileSync("zip.sha1.bin", c.createHash("sha256").update(zip).digest());
fs.writeFileSync("pub.der", spki);

// CRX3 protobuf header
const field = (n, blob) => {
  const key = n * 8 + 2;
  const kv = [], bl = [];
  let x = key; while (true) { const at7 = x & 0x7f; x >>>= 7; if (x) { kv.push(at7 | 0x80); } else { kv.push(at7); break; } }
  x = blob.length; while (true) { const at7 = x & 0x7f; x >>>= 7; if (x) { bl.push(at7 | 0x80); } else { bl.push(at7); break; } }
  return Buffer.concat([Buffer.from(kv), Buffer.from(bl), blob]);
};
const proof = field(1, spki);
const proofMsg = field(2, Buffer.concat([proof, field(2, sig)]));
const shd = field(1, crxid);
const header = Buffer.concat([proofMsg, field(10000, shd)]);

fs.writeFileSync("AUTOBUILD.HEAD", header);
const t = Buffer.alloc(12);
t.write("Cr24", 0, "ascii");
t.writeUInt32LE(3, 4);
t.writeUInt32LE(header.length, 8);
fs.writeFileSync(OUT, Buffer.concat([t, header, zip]));

console.log("zip", zip.length, "header", header.length, "sig", sig.length, "crxid", crxid.toString("hex"));
EOF

cp extension.zip crx-build/extension.zip

echo "built $OUT"