/**
 * random_email.mjs
 *
 * Generates random email addresses in the format:
 *   <randomuser><numeric>@dellakuyang.com
 *
 * Usage:
 *   node random_email.mjs            # print one email
 *   node random_email.mjs 10         # print 10 emails
 *
 * Or import:
 *   import { randomEmail } from "./random_email.mjs";
 */

import { randomInt } from "node:crypto";

const DOMAIN = "dellakuyang.com";

// Lowercase alphabet used for the random username portion.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/**
 * Build a random lowercase username of the given length.
 * @param {number} length - number of letters (default 8)
 * @returns {string}
 */
function randomUser(length = 8) {
  let user = "";
  for (let i = 0; i < length; i++) {
    user += ALPHABET[randomInt(ALPHABET.length)];
  }
  return user;
}

/**
 * Build a random numeric suffix of the given digit count.
 * @param {number} digits - number of digits (default 4)
 * @returns {string}
 */
function randomNumeric(digits = 4) {
  let numeric = "";
  for (let i = 0; i < digits; i++) {
    numeric += randomInt(10).toString();
  }
  return numeric;
}

/**
 * Generate a random email: <randomuser><numeric>@dellakuyang.com
 * @param {object} [options]
 * @param {number} [options.userLength=8]  - letters in the username
 * @param {number} [options.numericDigits=4] - digits in the numeric suffix
 * @returns {string}
 */
export function randomEmail({ userLength = 8, numericDigits = 4 } = {}) {
  return `${randomUser(userLength)}${randomNumeric(numericDigits)}@${DOMAIN}`;
}

// CLI entry point: run only when executed directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  const count = Math.max(1, Number.parseInt(process.argv[2] ?? "1", 10) || 1);
  for (let i = 0; i < count; i++) {
    console.log(randomEmail());
  }
}
