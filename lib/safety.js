// Lightweight safety layer: emergency pre-check + privacy redaction.
// This is NOT medical triage. It only guarantees that clearly urgent phrasing
// gets immediate guidance without waiting for an AI round trip. The AI system
// prompt separately instructs Claude to prioritise urgent guidance for
// anything the patterns below miss.
//
// NOTE: index.html contains a copy of these rules so urgent guidance still
// appears if the backend is down. Keep both lists in sync when editing.

export const EMERGENCY_RULES = [
  { id: 'breathing', kind: 'medical', test: (t) =>
      /\b(can'?t|cannot|can not|unable to|struggling to|hard to|difficulty|trouble)\s*(to\s+)?breath(e|ing)?\b/.test(t) ||
      /\b(not|stopped|stops)\s+breathing\b/.test(t) || /\bgasping for (air|breath)\b/.test(t) },
  { id: 'chest-pain', kind: 'medical', test: (t) =>
      /\bchest\s+(pain|pressure|tightness|heaviness)\b/.test(t) &&
      /\b(severe|crushing|sudden|worst|radiat\w*|left arm|jaw|sweat\w*|breath\w*|faint\w*|dizzy|nausea)\b/.test(t) },
  { id: 'heart-attack', kind: 'medical', test: (t) =>
      /\b(having|might be having|think i'?m having|think he'?s having|think she'?s having)\s+a\s+heart attack\b/.test(t) },
  { id: 'stroke', kind: 'medical', test: (t) =>
      /\bface\s+(is\s+)?(droop\w*|numb)\b/.test(t) || /\bslurred speech\b/.test(t) ||
      /\bsudden(ly)?\s+(weakness|numbness|confusion|loss of (vision|speech|balance))\b/.test(t) ||
      /\bcan'?t\s+(move|lift|raise)\s+(my|his|her)?\s*(arm|leg|face)\b/.test(t) },
  { id: 'unconscious', kind: 'medical', test: (t) =>
      /\b(unconscious|unresponsive|passed out|won'?t wake up|not waking up|collapsed|blacked out|losing consciousness)\b/.test(t) },
  { id: 'bleeding', kind: 'medical', test: (t) =>
      /\b(severe|heavy|uncontrolled|massive)\s+bleeding\b/.test(t) ||
      /\bbleeding\b.{0,30}\b(won'?t stop|not stopping|heavily)\b/.test(t) ||
      /\b(vomiting|coughing up|throwing up)\s+blood\b/.test(t) },
  { id: 'seizure', kind: 'medical', test: (t) =>
      /\b(having|had|started having|is having|has had)\s+(a\s+)?(seizure|convulsion|fit)s?\b/.test(t) },
  { id: 'allergic', kind: 'medical', test: (t) =>
      /\banaphyla\w*\b/.test(t) || /\b(throat|tongue|lips|face)\s+(is\s+)?(closing|swelling|swollen)\b/.test(t) ||
      /\bswelling (of|in) (my |the )?(throat|tongue|lips|face)\b/.test(t) },
  { id: 'choking', kind: 'medical', test: (t) => /\b(is|am|are|was)\s+choking\b/.test(t) },
  { id: 'poisoning', kind: 'medical', test: (t) =>
      /\boverdos\w*\b/.test(t) || /\btook too many (pills|tablets|capsules)\b/.test(t) ||
      /\bswallowed\s+(poison|bleach|pesticide|kerosene|acid)\b/.test(t) },
  { id: 'self-harm', kind: 'mental_health', test: (t) =>
      /\b(suicidal|kill myself|end my life|want to die|wanna die|don'?t want to (live|be alive)|thinking (of|about) (suicide|killing myself)|hurt myself|harm myself)\b/.test(t) }
];

function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns { emergency: false } or { emergency: true, kind, signals }. */
export function checkEmergency(text) {
  const t = normalise(text);
  const hits = EMERGENCY_RULES.filter((r) => r.test(t));
  if (!hits.length) return { emergency: false };
  const kind = hits.some((h) => h.kind === 'mental_health') ? 'mental_health' : 'medical';
  return { emergency: true, kind, signals: hits.map((h) => h.id) };
}

export const EMERGENCY_REPLY_MEDICAL =
  "**This could be a medical emergency. Please call 112 now** (India's emergency number; ambulance is 108 in many states) or go to the nearest emergency department immediately.\n\n" +
  "- Don't wait for an online reply, and don't drive yourself if you feel faint or unwell.\n" +
  "- Tell the operator your exact location and what is happening.\n" +
  "- Ask someone nearby to stay with you. If a person is unresponsive and not breathing normally, the operator can guide you through CPR.\n\n" +
  "I'm an educational assistant and can't assess your condition or send help. Once you are safe, I can answer follow-up questions.";

export const EMERGENCY_REPLY_MENTAL_HEALTH =
  "I'm really sorry you're going through this. Your safety matters.\n\n" +
  "**If you might act on these thoughts or are in immediate danger, call 112 now** or go to the nearest emergency department. Please don't stay alone: reach out to a family member, friend or neighbour and ask them to be with you.\n\n" +
  "You can also call **Tele-MANAS at 14416**, India's government mental health helpline, available in many languages.\n\n" +
  "I'm an educational assistant and can't provide crisis care, but I'm here to keep talking while you reach out to them.";

export function emergencyReply(kind) {
  return kind === 'mental_health' ? EMERGENCY_REPLY_MENTAL_HEALTH : EMERGENCY_REPLY_MEDICAL;
}

/** Remove obvious personal identifiers before text is sent to the AI provider. */
export function redact(text) {
  return String(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]')
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[id number removed]')
    .replace(/\+?\d[\d\s\-().]{8,}\d/g, (m) => {
      const digits = m.replace(/\D/g, '').length;
      return digits >= 10 && digits <= 15 ? '[phone removed]' : m;
    });
}
