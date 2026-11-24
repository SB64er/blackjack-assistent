// Einstellungen → Echtgeld & Risiko (optional).
// Budget, Startsaldo, Saldo, Einsätze und tatsächliche Auszahlungen protokollieren,
// Verlustlimits, Warnungen, Stopp-Empfehlung und Risikoanalyse.
// BJ.AI platziert keine Wetten, hat keinen Zugriff auf Casino-Konten und überträgt nichts.
import { View, subHeader } from './view-base.js';
import { ICONS, esc } from '../core/dom.js';
import { ENTRY_TEXT, computedPayout } from '../risk/bankroll.js';
import { assessRisk, stakeCheck, RISK_LEVEL_TEXT, HAND_SD } from '../risk/risk.js';
import { activeStrategyEVCached } from '../strategy/decision.js';
import { fmtDateTime } from './archive-view.js';
import { pct } from '../strategy/analysis.js';
import { rulesText } from '../strategy/standard.js';

const CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP'];
const num = (v) => {
  const s = String(v ?? '').trim().replace(/'/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

export class RiskView extends View {
  mount() {
    this.el.className = 'screen screen-sub';
    this._notice = null;
    this._editSetup = false;
    this._confirmClear = false;
    this._draft = { stake: '', extra: '', payout: '', outcome: null, blackjack: false, roundId: '', note: '' };
    this.el.innerHTML = `
      ${subHeader('Echtgeld & Risiko', 'einstellungen')}
      <div class="sub-content" data-slot="content"></div>`;
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.el.addEventListener('input', (e) => this._onInput(e));
    const r = () => this.render();
    this.listen(this.ctx.bankroll, 'change', r);
    this.listen(this.ctx.profiles, 'change', r);
    this.listen(this.ctx.settings, 'change', r);
    this.render();
  }

  _say(tone, text) { this._notice = { tone, text }; }

  _strategy() {
    const { profiles, settings } = this.ctx;
    const st = profiles.strategyFor();
    return { ...activeStrategyEVCached({ rules: settings.get('rules'), overrides: st.overrides, strategyRules: st.strategyRules }), profile: st.profile.name };
  }

  _onInput(e) {
    const t = e.target;
    if (t.dataset.draft) {
      this._draft[t.dataset.draft] = t.type === 'checkbox' ? t.checked : t.value;
      if (['stake', 'extra'].includes(t.dataset.draft) || t.dataset.draft === 'blackjack') this._prefill();
      this._renderHints();
    }
  }

  // Auszahlung aus Einsatz + Ergebnis vorschlagen (nur Vorschlag – die tatsächliche Auszahlung trägt der Benutzer ein).
  _prefill() {
    const d = this._draft;
    const stake = num(d.stake);
    if (!d.outcome || !(stake >= 0)) return;
    const p = computedPayout({ outcome: d.outcome, stake, extra: num(d.extra) || 0, blackjack: d.blackjack, payoutRule: this.ctx.settings.get('rules').payout });
    if (p != null) {
      d.payout = String(p);
      d.payoutComputed = true;
      const el = this.el.querySelector('[data-draft="payout"]');
      if (el) el.value = d.payout;
    }
  }

  async _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { bankroll, archive, settings } = this.ctx;
    const val = (name) => { const el = this.el.querySelector(`[name="${name}"]`); return el ? el.value : ''; };
    try {
      switch (btn.dataset.action) {
        case 'enable': {
          const ack = this.el.querySelector('input[name="ack"]');
          await bankroll.enable({ acknowledged: !!(ack && ack.checked) });
          this._say('ok', 'Echtgeld-Modus aktiviert. Lege jetzt Budget, Startsaldo und Verlustlimits fest.');
          break;
        }
        case 'disable':
          await bankroll.disable();
          this._say('ok', 'Echtgeld-Modus deaktiviert. Das Protokoll bleibt gespeichert.');
          break;
        case 'edit-setup': this._editSetup = true; break;
        case 'save-setup': {
          const budget = num(val('budget'));
          const start = num(val('start'));
          if (Number.isNaN(budget) || Number.isNaN(start)) throw new Error('Bitte gültige Beträge eingeben.');
          await bankroll.setup({ currency: val('currency'), budget, startBalance: start });
          this._editSetup = false;
          this._say('ok', 'Budget und Startsaldo gespeichert.');
          break;
        }
        case 'save-limits': {
          const L = { maxBet: num(val('maxBet')), sessionLoss: num(val('sessionLoss')), dailyLoss: num(val('dailyLoss')) };
          if (Object.values(L).some((x) => Number.isNaN(x))) throw new Error('Bitte gültige Beträge eingeben (leer = kein Limit).');
          await bankroll.setLimits(L);
          this._say('ok', 'Limits gespeichert und im Protokoll vermerkt.');
          break;
        }
        case 'session-start': await bankroll.startSession(); this._say('ok', 'Sitzung gestartet.'); break;
        case 'session-end': await bankroll.endSession(); this._say('ok', 'Sitzung beendet.'); break;
        case 'outcome': {
          this._draft.outcome = this._draft.outcome === btn.dataset.o ? null : btn.dataset.o;
          this._prefill();
          break;
        }
        case 'save-round': {
          const d = this._draft;
          const stake = num(d.stake);
          const extra = num(d.extra) || 0;
          const payout = num(d.payout);
          if (!(stake >= 0) || Number.isNaN(extra) || !(payout >= 0)) throw new Error('Bitte Einsatz und tatsächliche Auszahlung eingeben (Auszahlung 0 bei Verlust).');
          const res = await bankroll.addRound({ stake, extra, payout, roundId: d.roundId || null, note: d.note, payoutSource: d.payoutComputed && String(computedPayout({ outcome: d.outcome, stake, extra, blackjack: d.blackjack, payoutRule: settings.get('rules').payout })) === String(payout) ? 'computed' : 'manual' });
          if (d.roundId) {
            const rec = archive.get(d.roundId);
            if (rec) {
              const money = { currency: bankroll.config.currency, balanceBefore: res.balanceBefore, balanceAfter: res.balanceAfter, ledgerId: res.entry.id };
              const hands = rec.hands.length === 1 ? [{ bet: stake, extraBet: extra || null, payout }] : [];
              await archive.setMoney(d.roundId, { hands, money }, 'Echtgeld: Einsatz und Auszahlung ergänzt');
            }
          }
          this._draft = { stake: d.stake, extra: '', payout: '', outcome: null, blackjack: false, roundId: '', note: '' };
          this._say('ok', `Runde protokolliert: netto ${res.entry.net >= 0 ? '+' : ''}${res.entry.net.toFixed(2)} ${bankroll.config.currency}. Saldo ${res.balanceAfter.toFixed(2)}.`);
          break;
        }
        case 'transfer': {
          const amount = num(val('t-amount'));
          const type = val('t-type');
          if (!Number.isFinite(amount)) throw new Error('Bitte einen Betrag eingeben.');
          await bankroll.addTransfer(type, amount, val('t-note'));
          this._say('ok', `${ENTRY_TEXT[type]} gespeichert.`);
          break;
        }
        case 'clear-ask': this._confirmClear = true; break;
        case 'clear-cancel': this._confirmClear = false; break;
        case 'clear-do': {
          const ok = this.el.querySelector('input[name="clear-ok"]');
          if (!ok || !ok.checked) throw new Error('Bitte zuerst bestätigen, dass alle Echtgeld-Daten gelöscht werden sollen.');
          await bankroll.clearAll({ confirmed: true });
          this._confirmClear = false;
          this._say('ok', 'Alle Echtgeld-Daten wurden gelöscht.');
          break;
        }
        default: return;
      }
    } catch (err) {
      this._say('warn', err.message);
    }
    this.render();
  }

  _renderHints() {
    const el = this.el.querySelector('[data-slot="stake-hint"]');
    if (!el) return;
    const { bankroll } = this.ctx;
    const stake = num(this._draft.stake);
    const lastRound = [...bankroll.entries].reverse().find((e) => e.type === 'round') || null;
    const msgs = [];
    const chk = stakeCheck({ stake, lastRound });
    if (chk) msgs.push(chk.text);
    const risk = assessRisk({ config: bankroll.config, stats: bankroll.stats(), strategy: null, proposedStake: Number.isFinite(stake) ? stake : null });
    for (const m of risk.messages.filter((x) => x.code === 'over-max' || x.code === 'over-left')) msgs.push(m.text);
    el.innerHTML = msgs.map((t) => `<p class="notice notice--warn">${ICONS.warning}<span>${esc(t)}</span></p>`).join('');
  }

  render() {
    const { bankroll, archive } = this.ctx;
    const c = bankroll.config;
    const cur = c.currency;
    const notice = this._notice ? `<p class="notice notice--${this._notice.tone}" role="status">${this._notice.tone === 'ok' ? ICONS.check : ICONS.warning}<span>${esc(this._notice.text)}</span></p>` : '';
    const strat = this._strategy();
    const stats = bankroll.stats();
    const risk = assessRisk({ config: c, stats, strategy: strat });
    const m = (x) => (x == null ? '–' : `${x.toFixed(2)} ${cur}`);
    const warning = `
      <div class="danger-box" role="note">
        <p><b>Blackjack kann zu finanziellen Verlusten führen.</b> Auch mit mathematisch bester Strategie hat das Casino bei üblichen Regeln einen Vorteil. Es gibt keine Gewinngarantie. BJ.AI platziert keine Wetten, hat keinen Zugriff auf Casino-Konten und überträgt keine Beträge – alles bleibt auf diesem Gerät.</p>
      </div>`;
    const content = this.el.querySelector('[data-slot="content"]');
    if (!c.enabled) {
      content.innerHTML = `
        ${notice}
        ${warning}
        <p class="lead">Der Echtgeld-Modus ist optional. Er hilft, ein selbst festgelegtes Budget zu schützen: Saldo, Einsätze und tatsächliche Auszahlungen protokollieren, Verlustlimits setzen und rechtzeitig aufhören.</p>
        <section class="group">
          <h2 class="group-title">FESTE SCHUTZREGELN</h2>
          <ul class="plain-list">
            <li>Keine Martingale-Strategie und keine Einsatzverdoppelung nach Verlusten.</li>
            <li>Limits werden nie automatisch erhöht; während einer Sitzung nur senkbar.</li>
            <li>Keine Aufforderung, verlorenes Geld zurückzugewinnen.</li>
            <li>Keine Gewinnversprechen, keine automatische Ausführung von Wetten.</li>
            <li>Nach Erreichen eines Verlustlimits gibt es keine Einsatzempfehlung mehr – nur „Stopp“.</li>
          </ul>
        </section>
        <section class="group">
          <h2 class="group-title">MATHEMATIK FÜR DEINE TISCHREGELN</h2>
          <p>${esc(rulesText(this.ctx.settings.get('rules')))} · ${esc(strat.profile)}: Erwartungswert <b>${pct(strat.ev, 2)}</b> pro Einsatz (exakt berechnet, unendliches Deck).</p>
          ${risk.negativeEv ? `<p class="notice notice--warn">${ICONS.warning}<span>Negativer Erwartungswert: Auf lange Sicht verlierst du im Schnitt Geld. Die App rät vom Spiel mit echtem Geld ab.</span></p>` : ''}
        </section>
        <label class="row row--check"><span>Ich habe verstanden, dass Blackjack zu finanziellen Verlusten führen kann und es keine Gewinngarantie gibt.</span><input type="checkbox" name="ack"></label>
        <button type="button" class="btn btn--primary" data-action="enable">Echtgeld-Modus aktivieren</button>`;
      return;
    }

    const setupForm = c.startBalance == null || this._editSetup;
    const sessionOn = !!c.session;
    const rounds = archive.rounds.filter((r) => !r.money).slice(0, 15);
    const nets = bankroll.entries.filter((e) => e.type === 'round').map((e) => e.net);
    const meanNet = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : null;
    const sdNet = nets.length > 1 ? Math.sqrt(nets.reduce((a, x) => a + (x - meanNet) ** 2, 0) / (nets.length - 1)) : null;
    const ci = sdNet != null ? 1.96 * sdNet / Math.sqrt(nets.length) : null;
    const d = this._draft;

    content.innerHTML = `
      ${notice}
      ${warning}
      <section class="risk-card risk-card--${risk.level}" role="${risk.level === 'stop' ? 'alert' : 'status'}">
        <div class="risk-head"><span class="risk-level">${esc(RISK_LEVEL_TEXT[risk.level])}</span>${risk.stop ? '<b class="risk-stop">STOPP</b>' : ''}</div>
        ${risk.messages.map((x) => `<p class="risk-msg risk-msg--${x.tone}">${esc(x.text)}</p>`).join('')}
        <p class="hint">${risk.canSuggestStake ? `Einsatzrahmen nach deinen Limits: höchstens ${m(risk.maxStake)} pro Runde. Das ist eine Obergrenze, keine Empfehlung zu spielen.` : 'Keine Einsatzempfehlung.'}</p>
      </section>

      <div class="stat-grid">
        <div class="stat"><b>${m(stats.balance)}</b><span>aktueller Saldo</span></div>
        <div class="stat"><b>${m(c.startBalance)}</b><span>Startsaldo</span></div>
        <div class="stat"><b>${m(c.budget)}</b><span>Gesamtbudget</span></div>
        <div class="stat ${stats.net < 0 ? 'stat--bad' : 'stat--ok'}"><b>${stats.net >= 0 ? '+' : ''}${m(stats.net)}</b><span>netto (Runden)</span></div>
        <div class="stat stat--warn"><b>${stats.utilization != null ? `${Math.round(stats.utilization * 100)} %` : '–'}</b><span>Budget verbraucht</span></div>
        <div class="stat"><b>${m(stats.drawdown)}</b><span>Rückgang zum Höchststand</span></div>
      </div>

      ${setupForm ? `
        <section class="group">
          <h2 class="group-title">BUDGET UND STARTSALDO</h2>
          <div class="form-grid">
            <label class="field"><span>Währung</span><select name="currency">${CURRENCIES.map((x) => `<option ${x === cur ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
            <label class="field"><span>Gesamtbudget</span><input name="budget" inputmode="decimal" value="${c.budget ?? ''}" placeholder="z. B. 200"></label>
            <label class="field"><span>Startsaldo</span><input name="start" inputmode="decimal" value="${c.startBalance ?? ''}" placeholder="z. B. 200"></label>
          </div>
          <p class="hint">Das Gesamtbudget ist der Betrag, den du höchstens verlieren willst. Der Startsaldo wird im Protokoll vermerkt.</p>
          <button type="button" class="btn btn--primary" data-action="save-setup">Speichern</button>
        </section>` : `<button type="button" class="btn btn--ghost" data-action="edit-setup" ${sessionOn ? 'disabled' : ''}>Budget/Startsaldo neu festlegen${sessionOn ? ' (nach der Sitzung)' : ''}</button>`}

      <section class="group">
        <h2 class="group-title">VERLUSTLIMITS</h2>
        <div class="form-grid">
          <label class="field"><span>Max. Einsatz pro Runde</span><input name="maxBet" inputmode="decimal" value="${c.limits.maxBet ?? ''}" placeholder="leer = keins"></label>
          <label class="field"><span>Verlustlimit pro Sitzung</span><input name="sessionLoss" inputmode="decimal" value="${c.limits.sessionLoss ?? ''}" placeholder="leer = keins"></label>
          <label class="field"><span>Tagesverlustlimit (optional)</span><input name="dailyLoss" inputmode="decimal" value="${c.limits.dailyLoss ?? ''}" placeholder="leer = keins"></label>
        </div>
        <p class="hint">Warnung ab ${Math.round((c.warnAt || 0.8) * 100)} % eines Limits, Stopp beim Erreichen. ${sessionOn ? 'Während der laufenden Sitzung können Limits nur gesenkt werden.' : ''}</p>
        <button type="button" class="btn btn--secondary" data-action="save-limits">Limits speichern</button>
      </section>

      <section class="group">
        <h2 class="group-title">SITZUNG</h2>
        <p>${sessionOn ? `Läuft seit ${esc(fmtDateTime(c.session.startedAt))}: ${stats.session.rounds} Runden, netto ${stats.session.net >= 0 ? '+' : ''}${m(stats.session.net)}.` : 'Keine laufende Sitzung.'} Heute: ${stats.today.rounds} Runden, netto ${stats.today.net >= 0 ? '+' : ''}${m(stats.today.net)}.</p>
        <button type="button" class="btn ${sessionOn ? 'btn--secondary' : 'btn--primary'}" data-action="${sessionOn ? 'session-end' : 'session-start'}" ${c.startBalance == null ? 'disabled' : ''}>${sessionOn ? 'Sitzung beenden' : 'Sitzung starten'}</button>
      </section>

      <section class="group">
        <h2 class="group-title">RUNDE PROTOKOLLIEREN</h2>
        ${risk.stop ? `<p class="notice notice--warn">${ICONS.warning}<span>Ein Limit ist erreicht. Bitte nicht weiterspielen. Eine bereits gespielte Runde kannst du trotzdem nachtragen, damit der Saldo stimmt.</span></p>` : ''}
        <div class="form-grid">
          <label class="field"><span>Einsatz</span><input data-draft="stake" inputmode="decimal" value="${esc(d.stake)}" placeholder="tatsächlicher Einsatz"></label>
          <label class="field"><span>Zusatzeinsatz (Verdoppeln/Split)</span><input data-draft="extra" inputmode="decimal" value="${esc(d.extra)}" placeholder="0"></label>
        </div>
        <div class="segmented segmented--3" role="group" aria-label="Ergebnis (für Vorschlag)">
          ${[['win', 'Gewonnen'], ['loss', 'Verloren'], ['push', 'Push']].map(([o, l]) => `<button type="button" data-action="outcome" data-o="${o}" aria-pressed="${d.outcome === o}">${l}</button>`).join('')}
        </div>
        <label class="row row--check"><span>Blackjack (Auszahlung ${esc(this.ctx.settings.get('rules').payout)})</span><input type="checkbox" data-draft="blackjack" ${d.blackjack ? 'checked' : ''}></label>
        <label class="field"><span>Tatsächliche Auszahlung (inkl. Einsatz, 0 bei Verlust)</span><input data-draft="payout" inputmode="decimal" value="${esc(d.payout)}" placeholder="vom Tisch erhalten"></label>
        <p class="hint">Aus Einsatz und Ergebnis wird ein Vorschlag berechnet. Bitte mit der tatsächlich erhaltenen Auszahlung vergleichen.</p>
        <label class="field"><span>Archivrunde verknüpfen (optional)</span><select data-draft="roundId"><option value="">– keine –</option>${rounds.map((r) => `<option value="${esc(r.id)}" ${d.roundId === r.id ? 'selected' : ''}>${esc(fmtDateTime(r.startedAt))} · ${esc(r.hands.map((h) => h.cards.map((x) => x.rank).join(' ')).join(' | '))}</option>`).join('')}</select></label>
        <label class="field"><span>Notiz</span><input data-draft="note" value="${esc(d.note)}" maxlength="300"></label>
        <div data-slot="stake-hint"></div>
        <button type="button" class="btn btn--primary" data-action="save-round" ${c.startBalance == null ? 'disabled' : ''}>Runde speichern</button>
      </section>

      <section class="group">
        <h2 class="group-title">RISIKOANALYSE</h2>
        <ul class="ev-list">
          <li><span>Tatsächlich gewonnen / verloren</span><b>${m(stats.won)} / ${m(stats.lost)}</b></li>
          <li><span>Durchschnittlicher Einsatz</span><b>${m(stats.avgStake)}</b></li>
          <li><span>Längste Verlustserie</span><b>${stats.longestLossStreak} Runden (${m(stats.worstLossRun)})</b></li>
          <li><span>Rückgang zum höchsten Stand</span><b>${m(stats.drawdown)}</b></li>
          <li><span>Ergebnis pro Runde (deine Daten)</span><b>${meanNet != null ? `${meanNet >= 0 ? '+' : ''}${meanNet.toFixed(2)} ${cur}${ci != null ? ` ± ${ci.toFixed(2)}` : ''}` : '–'}</b></li>
          <li><span>Erwartungswert der Strategie (Mathematik)</span><b>${pct(strat.ev, 2)} pro Einsatz</b></li>
        </ul>
        ${risk.outlook100 ? `<p class="hint">Bei ${m(stats.avgStake || c.limits.maxBet)} Einsatz über 100 Runden: im Mittel ${risk.outlook100.expected.toFixed(2)} ${cur}, mit 95 % Wahrscheinlichkeit zwischen ${risk.outlook100.low.toFixed(2)} und ${risk.outlook100.high.toFixed(2)} ${cur} (Normalnäherung, Streuung ${HAND_SD} Einsätze pro Runde).</p>` : ''}
        <p class="hint">${nets.length < 30 ? `Erst ${nets.length} Runden erfasst – dein eigenes Ergebnis sagt noch fast nichts über die Strategie aus.` : 'Dein Ergebnis schwankt stark zufällig; der ±-Bereich zeigt die Unsicherheit (95 %).'}</p>
      </section>

      <section class="group">
        <h2 class="group-title">EIN-/AUSZAHLUNG ODER KORREKTUR</h2>
        <div class="form-grid">
          <label class="field"><span>Art</span><select name="t-type"><option value="deposit">${ENTRY_TEXT.deposit}</option><option value="withdrawal">${ENTRY_TEXT.withdrawal}</option><option value="correction">${ENTRY_TEXT.correction} (±)</option></select></label>
          <label class="field"><span>Betrag</span><input name="t-amount" inputmode="decimal" placeholder="z. B. 50 oder -5"></label>
          <label class="field"><span>Notiz</span><input name="t-note" maxlength="300"></label>
        </div>
        <button type="button" class="btn btn--secondary" data-action="transfer">Buchen</button>
      </section>

      <section class="group">
        <h2 class="group-title">PROTOKOLL</h2>
        <p class="hint">Jede Änderung ist ein eigener Eintrag (nichts wird überschrieben).</p>
        <ul class="history-list">${[...bankroll.entries].reverse().slice(0, 60).map((e) => `<li><span class="meta">${esc(fmtDateTime(e.at))} · ${esc(ENTRY_TEXT[e.type])}</span><span>${entryText(e, cur)}</span></li>`).join('') || '<li><span>Noch keine Einträge.</span></li>'}</ul>
      </section>

      <section class="group">
        <h2 class="group-title">MODUS UND DATEN</h2>
        <button type="button" class="btn btn--ghost" data-action="disable">Echtgeld-Modus deaktivieren</button>
        ${this._confirmClear ? `
          <div class="danger-box">
            <p><b>Alle Echtgeld-Daten endgültig löschen?</b> Budget, Limits und Protokoll gehen verloren.</p>
            <label class="row row--check"><span>Ja, alle Echtgeld-Daten löschen.</span><input type="checkbox" name="clear-ok"></label>
            <div class="btn-row">
              <button type="button" class="btn btn--danger" data-action="clear-do">Endgültig löschen</button>
              <button type="button" class="btn btn--ghost" data-action="clear-cancel">Abbrechen</button>
            </div>
          </div>` : '<button type="button" class="btn btn--ghost" data-action="clear-ask">Echtgeld-Daten löschen …</button>'}
        <p class="hint">Export: Einstellungen → Spielarchiv → „Als JSON exportieren“ (enthält das Echtgeld-Protokoll).</p>
      </section>`;
    this._renderHints();
  }
}

function entryText(e, cur) {
  const m = (x) => `${Number(x).toFixed(2)} ${cur}`;
  switch (e.type) {
    case 'round': return esc(`Einsatz ${m(e.stake)}${e.extra ? ` + ${m(e.extra)}` : ''}, Auszahlung ${m(e.payout)}${e.payoutSource === 'computed' ? ' (berechnet)' : ''} → netto ${e.net >= 0 ? '+' : ''}${m(e.net)}${e.note ? ` · ${e.note}` : ''}`);
    case 'start': case 'deposit': case 'withdrawal': case 'correction': return esc(`${m(e.amount)}${e.note ? ` · ${e.note}` : ''}`);
    case 'limits': {
      const f = (l) => (l ? `Einsatz ${l.maxBet ?? '–'}, Sitzung ${l.sessionLoss ?? '–'}, Tag ${l.dailyLoss ?? '–'}` : '–');
      return esc(`${f(e.before)} → ${f(e.after)}`);
    }
    default: return esc(e.note || '');
  }
}
