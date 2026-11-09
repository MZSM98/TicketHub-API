const DUPLICATE_ENTRY = 1062;

export async function insertUnlessActive(insert, lookupActive, rounds) {
  for (let round = 1; round <= rounds; round++) {
    try {
      return { id: await insert() };
    } catch (err) {
      if (err?.errno !== DUPLICATE_ENTRY) throw err;
      const activeId = await lookupActive();
      if (activeId !== null) return { activeId };
    }
  }
  return { exhausted: true };
}
