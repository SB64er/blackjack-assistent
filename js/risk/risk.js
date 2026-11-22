// YUMEKO – Risikointelligenz.
// Unabhängig von der Strategieintelligenz: Sie entscheidet NICHT über Ziehen/Stehen,
// sondern prüft Budget, Limits, Verlustrisiko und ob gespielt werden sollte.
// Eine Spielaktion ist nie eine Empfehlung, überhaupt Geld einzusetzen.
//
// Schutzregeln (fest eingebaut, nicht abschaltbar):
//  - keine Martingale-/Verdoppelungsstrategie, keine Erhöhung nach Verlusten
//  - keine automatische Erhöhung von Limits
//  - keine Aufforderung, Verluste zurückzugewinnen
//  - keine Gewinnversprechen, keine automatische Wette
// Reine Logik (ohne DOM) -> testbar.

export const RISK_LEVEL_TEXT = { off: 'Echtgeld-Modus aus', ok: 'Im Rahmen', warn: 'Achtung', stop: 'Stopp empfohlen' };
export const HAND_SD = 1.15; // typische Standardabweichung pro Runde in Einsätzen (Blackjack)

const fmt = (x, cur) => `${(Math.round(x * 100) / 100).toFixed(2)} ${cur}`;
const pctTxt = (x, d = 2) => `${(x * 100).toFixed(d).replace('-', '−')} %`;

/**
 * Erwartung und Schwankung für n Runden bei Einsatz bet.
 * @returns {{ expected, low, high }} 95-%-Bereich (Normalnäherung)
 */
export function outlook(ev, bet, n, sd = HAND_SD) {
  const expected = ev * bet * n;
  const spread = 1.96 * sd * bet * Math.sqrt(n);
  return { expected, low: expected - spread, high: expected + spread };
}

/**
 * @param {{ config, stats, strategy?: { ev: number, label?: string, rulesText?: string },
 *   proposedStake?: number|null, lastStake?: number|null }} input
 * @returns {{ level, stop, canSuggestStake, maxStake, negativeEv, messages: Array<{tone, code, text}>,
 *   outlook100: object|null }}
 */
export function assessRisk({ config, stats, strategy = null, proposedStake = null }) {
  const cur = config.currency || 'CHF';
  const messages = [];
  const add = (tone, code, text) => messages.push({ tone, code, text });
  const negativeEv = !!strategy && typeof strategy.ev === 'number' && strategy.ev < 0;

  if (negativeEv) {
    add('warn', 'negative-ev', `Unter diesen Tischregeln hat auch die mathematisch beste Strategie einen negativen Erwartungswert (${pctTxt(strategy.ev, 2)} pro Einsatz${strategy.label ? `, ${strategy.label}` : ''}). Langfristig ist mit Verlust zu rechnen. YUMEKO rät vom Spiel mit echtem Geld ab.`);
  } else if (strategy && typeof strategy.ev === 'number') {
    add('info', 'ev', `Rechnerischer Erwartungswert ${pctTxt(strategy.ev, 2)} pro Einsatz. Auch ein positiver Wert garantiert keinen Gewinn – kurzfristig entscheidet der Zufall.`);
  }

  if (!config.enabled) {
    return { level: 'off', stop: false, canSuggestStake: false, maxStake: null, negativeEv, messages, outlook100: null };
  }
  if (config.startBalance == null) {
    add('info', 'setup', 'Lege zuerst Gesamtbudget, Startsaldo und Limits fest.');
    return { level: 'warn', stop: false, canSuggestStake: false, maxStake: null, negativeEv, messages, outlook100: null };
  }

  const w = config.warnAt || 0.8;
  const L = config.limits || {};
  let stop = false;
  let warn = negativeEv;

  if (stats.balance <= 0) { stop = true; add('stop', 'balance', 'Der Saldo ist aufgebraucht. Bitte nicht weiterspielen.'); }

  const check = (limit, used, code, name) => {
    if (limit == null) return Infinity;
    if (used >= limit - 1e-9) {
      stop = true;
      add('stop', code, `${name} erreicht (${fmt(used, cur)} von ${fmt(limit, cur)}). Stopp: Die Sitzung jetzt beenden. Es gibt keine weiteren Einsatzempfehlungen.`);
      return 0;
    }
    if (used >= limit * w) {
      warn = true;
      add('warn', `${code}-near`, `${name} fast erreicht: ${fmt(used, cur)} von ${fmt(limit, cur)} verloren (${Math.round((used / limit) * 100)} %).`);
    }
    return limit - used;
  };
  const leftSession = check(L.sessionLoss, stats.session.loss, 'session-limit', 'Verlustlimit der Sitzung');
  const leftDay = check(L.dailyLoss, stats.today.loss, 'daily-limit', 'Tagesverlustlimit');
  let leftBudget = Infinity;
  if (config.budget != null && stats.utilization != null) {
    const used = stats.utilization * config.budget;
    leftBudget = check(config.budget, used, 'budget', 'Gesamtbudget');
  }

  if (stats.raisesAfterLoss > 0) {
    warn = true;
    add('warn', 'chasing', `Im Protokoll wurde der Einsatz ${stats.raisesAfterLoss}× direkt nach einem Verlust erhöht. Das ist das Muster von Verlustjagd/Martingale und erhöht das Risiko grosser Verluste. Es lässt sich damit nichts zurückgewinnen, was nicht dem Zufall überlassen bleibt.`);
  }
  if (stats.drawdown > 0 && config.budget) {
    const dd = stats.drawdown / config.budget;
    if (dd >= 0.5) { warn = true; add('warn', 'drawdown', `Aktueller Rückgang ${fmt(stats.drawdown, cur)} gegenüber dem höchsten Stand (${Math.round(dd * 100)} % des Budgets).`); }
  }

  const caps = [L.maxBet ?? Infinity, leftSession, leftDay, leftBudget, Math.max(0, stats.balance)];
  let maxStake = Math.min(...caps);
  if (!Number.isFinite(maxStake)) maxStake = null;
  if (stop) maxStake = null;

  if (proposedStake != null && !stop) {
    if (L.maxBet != null && proposedStake > L.maxBet) { warn = true; add('warn', 'over-max', `Der Einsatz ${fmt(proposedStake, cur)} liegt über deinem Einsatzlimit von ${fmt(L.maxBet, cur)}.`); }
    if (maxStake != null && proposedStake > maxStake) { warn = true; add('warn', 'over-left', `Mit ${fmt(proposedStake, cur)} könntest du ein Verlustlimit überschreiten (höchstens ${fmt(maxStake, cur)}).`); }
  }

  if (!stop && L.sessionLoss == null && L.dailyLoss == null) {
    warn = true;
    add('warn', 'no-limit', 'Es ist kein Verlustlimit festgelegt. Lege vor dem Spielen ein Sitzungs- oder Tageslimit fest.');
  }

  const bet = stats.avgStake || (L.maxBet ?? null);
  const out = strategy && typeof strategy.ev === 'number' && bet ? outlook(strategy.ev, bet, 100) : null;

  return {
    level: stop ? 'stop' : (warn ? 'warn' : 'ok'),
    stop,
    canSuggestStake: !stop && maxStake != null && maxStake > 0,
    maxStake,
    negativeEv,
    messages,
    outlook100: out
  };
}

/** Prüft einen geplanten Einsatz gegen den letzten (Schutz vor Verdoppeln nach Verlust). */
export function stakeCheck({ stake, lastRound }) {
  if (!lastRound || !(stake > 0)) return null;
  if (lastRound.net < 0 && stake > lastRound.stake) {
    return { tone: 'warn', code: 'raise-after-loss', text: 'Du erhöhst den Einsatz direkt nach einem Verlust. YUMEKO empfiehlt das nie: Verluste lassen sich so nicht verlässlich ausgleichen, das Risiko steigt.' };
  }
  return null;
}
