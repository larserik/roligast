import crypto from "node:crypto";

// Alphabet without easily confused characters (0/O, 1/I/L, U).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

// Random public id such as "K7QM4P". Unlike the row id it reveals neither how
// many rows exist nor in which order they were created.
export function generatePublicId(length = 6) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return out;
}

// Post ids end up in shareable URLs and there will be far more posts than
// users, so they are longer: 30^10 combinations makes both collisions and
// guessing an unlisted post impractical.
export const generatePostId = () => generatePublicId(10);

// Identifies a browser that has not signed in, so that a visitor rates a post
// once rather than once per page load. Random and meaningless on its own.
export const generateVisitorId = () => crypto.randomBytes(16).toString("hex");
