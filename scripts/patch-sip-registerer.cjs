const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, '..', 'node_modules', 'sip.js', 'lib', 'api', 'registerer.js');
const original = `                if (!contacts) {
                    this.logger.error("No Contact header in response to REGISTER, dropping response.");
                    this.unregistered();
                    return;
                }`;
const patched = `                if (!contacts) {
                    this.logger.error("No Contact header in response to REGISTER, dropping response.");
                    this.unregistered();
                    this.waitingToggle(false);
                    return;
                }`;

const source = fs.readFileSync(target, 'utf8');
if (source.includes(patched)) {
  console.log('SIP.js REGISTER final-response patch already applied.');
} else if (source.includes(original)) {
  fs.writeFileSync(target, source.replace(original, patched), 'utf8');
  console.log('Applied SIP.js REGISTER final-response patch.');
} else {
  throw new Error(`SIP.js registerer layout changed; refusing an unverified patch: ${target}`);
}
