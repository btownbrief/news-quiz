// Converts the exported "Daily Trivia Database - Questions.csv" into
// data/questions.json for the static News Quiz.
//
// CSV columns: Question, Option_A, Option_B, Option_C, Option_D, Correct_Answer
// Correct_Answer is a letter A–D. Usage:
//   node scripts/convert-csv.mjs "/path/to/export.csv"
import fs from 'node:fs';

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/convert-csv.mjs <csv-path>');
  process.exit(1);
}

function parseCSV(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const raw = fs.readFileSync(csvPath, 'utf8');
const rows = parseCSV(raw).filter((r) => r.length >= 6 && r.some((x) => x.trim()));
const header = rows.shift();
const letterIndex = { A: 0, B: 1, C: 2, D: 3 };

const questions = rows.map((r, i) => {
  const [q, a, b, c, d, correct] = r.map((x) => x.trim());
  const options = [a, b, c, d];
  const answer = letterIndex[correct.toUpperCase()];
  if (answer === undefined) throw new Error(`Row ${i + 1}: bad Correct_Answer "${correct}"`);
  return { id: i + 1, q, options, answer };
});

const out = {
  // Bump `edition` (or just overwrite this file) each Brief. The whole file
  // is this edition's quiz — every player gets these same questions.
  edition: new Date().toISOString().slice(0, 10),
  questions,
};

fs.writeFileSync(new URL('../data/questions.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${questions.length} questions to data/questions.json`);
