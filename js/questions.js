// News Quiz loads the CURRENT edition's quiz from data/questions.json.
// Unlike the trivia ladder there's no big bank / daily seed: the whole file
// IS this edition's five questions, refreshed each Btown Brief. The `edition`
// string gates replays — publish a new edition and everyone can play again.

export async function loadEdition() {
  const res = await fetch('data/questions.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`questions.json: HTTP ${res.status}`);
  const data = await res.json();
  return {
    edition: data.edition || 'default',
    questions: Array.isArray(data.questions) ? data.questions : [],
  };
}
