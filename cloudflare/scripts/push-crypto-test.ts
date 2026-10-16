// Test entrypoint only. No production process invokes Node for encryption.
import { encrypt, b64, unb64 } from "../src/push-crypto";
import { decrypt } from "../test/push-receiver";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const v = JSON.parse(input);
const body = await encrypt(
  new TextEncoder().encode(v.message),
  v.p256dh,
  v.auth,
);
console.log(
  JSON.stringify({
    encrypted: b64(body),
    decrypted: await decrypt(unb64(v.encrypted), v.receiver, v.auth),
  }),
);
