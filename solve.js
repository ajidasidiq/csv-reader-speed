// A fast CSV reader with exactly csv-reader 1.0.0's answers.
//
// Semantics (csv-reader 1.0.0's broken-row policy, reimplemented here from the
// spec, not copied from its source): the text is read once, left to right.
// A U+FEFF at the very start is dropped. A record ends at LF or CRLF, and a
// line left with no characters is no record. Outside quotes a CR not followed
// by LF is dropped (stray_cr). A field that opens with a quote runs to the
// next quote that is not doubled, "" inside it one quote, each CRLF or lone CR
// inside it read as LF; what follows its closing quote, up to the next comma
// or line break, is appended as it stands (quote_junk, when the field ends);
// a quote that never closes is a literal character, and the text after it is
// read again as unquoted (unterminated_quote). A quote inside an unquoted
// field is a literal character. Fields stay strings, never trimmed or
// converted. columns is the first record when header is true, else null; rows
// holds the records after it, each padded with empty strings (short_row) or
// cut (long_row) to the first record's width. Each error is {code, line, row},
// in the order met; line is the 1-based line its record starts on.
//
// Speed: delimiters are found with native indexOf (commas, line breaks and
// closing quotes are dense), fields are built with one slice each instead of
// per-character concatenation, no object is allocated per field, and CRs —
// sparse in LF files — are located through one precomputed sorted list of CR
// positions, so testing for a CR inside a field is O(1) amortised instead of
// a rescan. No dependencies, no regex in the hot loop.

const C_COMMA = 44;
const C_QUOTE = 34;
const C_LF = 10;
const C_CR = 13;
const C_BOM = 0xfeff;

// How a field ended.
const E_COMMA = 0;
const E_BREAK = 1;
const E_END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  // Every CR position, ascending. One native pass; every later CR test then
  // costs a pointer advance instead of a fresh scan for the next CR.
  const crPos = [];
  let rp = text.indexOf('\r');
  while (rp !== -1) {
    crPos.push(rp);
    rp = text.indexOf('\r', rp + 1);
  }
  const crLen = crPos.length;
  let rIdx = 0; // first crPos entry >= the current scan position

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === C_BOM) pos = 1;

  // The record being read: the line it starts on, its index in rows (null:
  // the header). Errors report these, never the moving scan line.
  let recordLine = 1;
  let recordRow = null;

  // Scratch: the last field read.
  let fVal = '';
  let fEnd = E_END;

  // First CR position >= `from`, by binary search (only used after the scan
  // position jumps backwards, which only the unterminated-quote path does).
  function crLowerBound(from) {
    let lo = 0;
    let hi = crLen;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (crPos[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Reads one unquoted field starting at pos, with `init` as its starting
  // value. Sets fVal/fEnd. Consumes the delimiter it ends at.
  function readUnquoted(init) {
    let acc = null; // kept text once a stray CR split the field; null = one slice
    let start = pos;
    for (;;) {
      const iC = text.indexOf(',', pos);
      const iL = text.indexOf('\n', pos);
      let end;
      let kind;
      if (iC !== -1 && (iL === -1 || iC < iL)) {
        end = iC;
        kind = E_COMMA;
      } else if (iL !== -1) {
        end = iL;
        kind = E_BREAK;
      } else {
        end = n;
        kind = E_END;
      }
      while (rIdx < crLen && crPos[rIdx] < pos) rIdx++;
      const r = rIdx < crLen ? crPos[rIdx] : -1;
      if (r !== -1 && r < end) {
        if (kind === E_BREAK && r === end - 1) {
          // CRLF line break: the field ends before the CR.
          fVal = acc === null ? init + text.slice(start, end - 1) : acc + text.slice(start, end - 1);
          pos = end + 1;
          line++;
          fEnd = E_BREAK;
          return;
        }
        // Stray CR: error, drop the CR, keep scanning the same field.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        acc = acc === null ? init + text.slice(start, r) : acc + text.slice(start, r);
        pos = r + 1;
        start = r + 1;
        rIdx++;
        continue;
      }
      if (kind === E_COMMA) {
        fVal = acc === null ? init + text.slice(start, end) : acc + text.slice(start, end);
        pos = end + 1;
        fEnd = E_COMMA;
      } else if (kind === E_BREAK) {
        fVal = acc === null ? init + text.slice(start, end) : acc + text.slice(start, end);
        pos = end + 1;
        line++;
        fEnd = E_BREAK;
      } else {
        fVal = acc === null ? init + text.slice(start, end) : acc + text.slice(start, end);
        pos = n;
        fEnd = E_END;
      }
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal/fEnd.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let ln = line; // speculative line count, committed only if the quote closes
    pos++;
    let acc = null; // value pieces; null until the first segment lands
    let p = pos; // start of the current unprocessed segment
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        rIdx = crLowerBound(open + 1);
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      // The segment [p, q): any CR or LF inside it?
      while (rIdx < crLen && crPos[rIdx] < p) rIdx++;
      const r = rIdx < crLen ? crPos[rIdx] : -1;
      const hasCR = r !== -1 && r < q;
      const nl0 = text.indexOf('\n', p);
      const hasNL = nl0 !== -1 && nl0 < q;
      if (!hasCR && !hasNL) {
        const seg = text.slice(p, q);
        acc = acc === null ? seg : acc + seg;
      } else if (!hasCR) {
        // Newlines only: count them, keep the segment as it stands.
        let c = 0;
        let i = nl0;
        while (i !== -1 && i < q) {
          c++;
          i = text.indexOf('\n', i + 1);
        }
        ln += c;
        const seg = text.slice(p, q);
        acc = acc === null ? seg : acc + seg;
      } else {
        // CRs present: walk the segment, each CRLF or lone CR one LF.
        let out = '';
        let s = p;
        for (let i = p; i < q; i++) {
          const ch = text.charCodeAt(i);
          if (ch === C_CR) {
            out += text.slice(s, i) + '\n';
            ln++;
            if (i + 1 < q && text.charCodeAt(i + 1) === C_LF) i++;
            s = i + 1;
          } else if (ch === C_LF) {
            ln++;
          }
        }
        out += text.slice(s, q);
        acc = acc === null ? out : acc + out;
        while (rIdx < crLen && crPos[rIdx] < q) rIdx++;
      }
      // Doubled quote, or the closing quote?
      if (q + 1 < n && text.charCodeAt(q + 1) === C_QUOTE) {
        acc = (acc === null ? '' : acc) + '"';
        p = q + 2;
        continue;
      }
      pos = q + 1;
      line = ln;
      break;
    }
    const value = acc === null ? '' : acc;
    if (pos >= n) {
      fVal = value;
      fEnd = E_END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === C_COMMA) {
      pos++;
      fVal = value;
      fEnd = E_COMMA;
      return;
    }
    if (c === C_LF) {
      pos++;
      line++;
      fVal = value;
      fEnd = E_BREAK;
      return;
    }
    if (c === C_CR && pos + 1 < n && text.charCodeAt(pos + 1) === C_LF) {
      pos += 2;
      line++;
      fVal = value;
      fEnd = E_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquoted(value);
    if (fVal.length - value.length > 0) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === C_LF) {
        pos++;
        line++;
      } else if (c === C_CR && pos + 1 < n && text.charCodeAt(pos + 1) === C_LF) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === C_QUOTE) {
        readQuoted();
        lastQuoted = true;
      } else {
        // Plain unquoted field, inlined: the hot path (readUnquoted('') is
        // kept for the junk / unterminated-quote paths, which pass a value).
        let acc = null;
        let start = pos;
        for (;;) {
          const iC = text.indexOf(',', pos);
          const iL = text.indexOf('\n', pos);
          let end;
          let kind;
          if (iC !== -1 && (iL === -1 || iC < iL)) {
            end = iC;
            kind = E_COMMA;
          } else if (iL !== -1) {
            end = iL;
            kind = E_BREAK;
          } else {
            end = n;
            kind = E_END;
          }
          while (rIdx < crLen && crPos[rIdx] < pos) rIdx++;
          const r = rIdx < crLen ? crPos[rIdx] : -1;
          if (r !== -1 && r < end) {
            if (kind === E_BREAK && r === end - 1) {
              fVal = acc === null ? text.slice(start, end - 1) : acc + text.slice(start, end - 1);
              pos = end + 1;
              line++;
              fEnd = E_BREAK;
              break;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            acc = acc === null ? text.slice(start, r) : acc + text.slice(start, r);
            pos = r + 1;
            start = r + 1;
            rIdx++;
            continue;
          }
          if (kind === E_COMMA) {
            fVal = acc === null ? text.slice(start, end) : acc + text.slice(start, end);
            pos = end + 1;
            fEnd = E_COMMA;
          } else if (kind === E_BREAK) {
            fVal = acc === null ? text.slice(start, end) : acc + text.slice(start, end);
            pos = end + 1;
            line++;
            fEnd = E_BREAK;
          } else {
            fVal = acc === null ? text.slice(start, end) : acc + text.slice(start, end);
            pos = n;
            fEnd = E_END;
          }
          break;
        }
        lastQuoted = false;
      }
      fields.push(fVal);
    } while (fEnd === E_COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
