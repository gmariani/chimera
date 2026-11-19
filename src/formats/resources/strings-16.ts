import { stringTableParser } from './strings';

/** A string table saved from a 16-bit Windows module: each string's length is a byte, its text in the code page. See strings.ts. */
export default stringTableParser(false);
