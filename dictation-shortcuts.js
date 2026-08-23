'use strict';

function isDictationOpen() {
  const layer = document.getElementById('dictation-layer');
  return Boolean(layer && !layer.hidden);
}

document.addEventListener('keydown', (event) => {
  if (!isDictationOpen()) return;

  if (event.key === 'Tab') {
    event.preventDefault();
    event.stopPropagation();
    const audioButton = document.getElementById('dictation-audio');
    if (audioButton && !audioButton.disabled) audioButton.click();
    return;
  }

  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof dictationState === 'undefined' || !dictationState.current) return;
    if (dictationState.answered) {
      if (typeof nextDictationWord === 'function') nextDictationWord();
    } else if (typeof submitDictation === 'function') {
      submitDictation(false);
    }
  }
}, true);
