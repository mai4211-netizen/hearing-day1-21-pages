'use strict';

const DICTATION_MASTERY_STREAK = 3;

function normalizeLegacyMistakeStat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const wrongCount = Math.max(0, Number(raw.wrongCount ?? raw.wrong ?? 0));
  if (!wrongCount) return null;
  const recoveryStreak = Math.max(0, Number(raw.recoveryStreak ?? raw.streak ?? 0));
  if (recoveryStreak >= DICTATION_MASTERY_STREAK) return null;
  return {
    wrongCount,
    recoveryStreak,
    lastWrong: Math.max(0, Number(raw.lastWrong || 0)),
  };
}

function migrateDictationMistakeStore() {
  const source = dictationState.store.stats && typeof dictationState.store.stats === 'object'
    ? dictationState.store.stats
    : {};
  const mistakes = {};

  for (const [wordKey, raw] of Object.entries(source)) {
    const stat = normalizeLegacyMistakeStat(raw);
    if (stat) mistakes[wordKey] = stat;
  }

  dictationState.store.stats = mistakes;
  saveDictationStore();
}

getStat = function getMistakeStat(wordKey) {
  const stat = dictationState.store.stats[wordKey];
  return stat && typeof stat === 'object' ? stat : null;
};

weightedPick = function weightedPickMistakes(records) {
  if (!records.length) return null;

  const weighted = records.map((record) => {
    const key = normalizeWordKey(record.word);
    const stat = getStat(key);
    if (!stat) return { record, weight: 1 };

    const wrongCount = Math.max(1, Number(stat.wrongCount || 1));
    const recoveryStreak = Math.max(0, Number(stat.recoveryStreak || 0));
    const recentWrong = stat.lastWrong && Date.now() - stat.lastWrong < 1000 * 60 * 60 * 24 * 30;
    const mistakeBoost = Math.min(8, wrongCount) * 1.6 + (recentWrong ? 1.4 : 0);
    const recoveryFactor = 1 / (1 + recoveryStreak * 0.75);

    return { record, weight: 1 + mistakeBoost * recoveryFactor };
  });

  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let needle = Math.random() * total;
  for (const item of weighted) {
    needle -= item.weight;
    if (needle <= 0) return item.record;
  }
  return weighted[weighted.length - 1].record;
};

markSeen = function markSeenTodayOnly(record) {
  ensureToday();
  const key = normalizeWordKey(record.word);
  if (!dictationState.store.seenToday.includes(key)) dictationState.store.seenToday.push(key);
  saveDictationStore();
};

recordResult = function recordMistakesOnly(record, correct) {
  const key = normalizeWordKey(record.word);
  const stat = getStat(key);

  if (!correct) {
    dictationState.store.stats[key] = {
      wrongCount: Math.max(0, Number(stat?.wrongCount || 0)) + 1,
      recoveryStreak: 0,
      lastWrong: Date.now(),
    };
    saveDictationStore();
    return;
  }

  // 普通答对词不写入长期记录。只有已经进入错词池的词才记录“恢复进度”。
  if (!stat) return;

  const recoveryStreak = Math.max(0, Number(stat.recoveryStreak || 0)) + 1;
  if (recoveryStreak >= DICTATION_MASTERY_STREAK) {
    delete dictationState.store.stats[key];
  } else {
    dictationState.store.stats[key] = { ...stat, recoveryStreak };
  }
  saveDictationStore();
};

migrateDictationMistakeStore();
