// Gespeicherte Simulationen – strikt getrennt von echten Spielrunden
// (eigener Datenbankbereich "simulations"). Simulierte Ergebnisse fliessen nie
// in Archiv, Saldo oder Archivanalyse ein.
import { Emitter } from '../core/events.js';

export const MAX_SIMULATIONS = 50;

export function validateSimulation(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !Array.isArray(x.results) || !x.results.length) return null;
  if (typeof x.at !== 'string' || Number.isNaN(Date.parse(x.at))) return null;
  return {
    id: x.id,
    kind: 'simulation',
    at: x.at,
    rules: x.rules || null,
    rounds: Number.isFinite(x.rounds) ? x.rounds : 0,
    seed: Number.isFinite(x.seed) ? x.seed : 0,
    note: typeof x.note === 'string' ? x.note.slice(0, 300) : '',
    results: x.results.filter((r) => r && typeof r.name === 'string' && Number.isFinite(r.ev)).slice(0, 12)
  };
}

export class SimulationStore extends Emitter {
  constructor({ db }) {
    super();
    this.list = [];
    this.error = null;
    this._ready = Promise.resolve(db).then(async (d) => {
      this.db = d;
      this.list = (await d.all('simulations')).map(validateSimulation).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at));
      this.emit('change', { type: 'load' });
    }).catch((err) => {
      this.error = `Simulationen konnten nicht geladen werden: ${err.message}`;
      this.emit('change', { type: 'error' });
    });
  }

  ready() { return this._ready; }

  async add(sim) {
    await this._ready;
    const v = validateSimulation({ id: `sim_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: new Date().toISOString(), ...sim });
    if (!v) throw new Error('Ungültige Simulation.');
    await this.db.put('simulations', v);
    this.list = [v, ...this.list];
    for (const old of this.list.slice(MAX_SIMULATIONS)) await this.db.delete('simulations', old.id);
    this.list = this.list.slice(0, MAX_SIMULATIONS);
    this.emit('change', { type: 'add', id: v.id });
    return v;
  }

  async remove(id) {
    await this._ready;
    await this.db.delete('simulations', id);
    this.list = this.list.filter((s) => s.id !== id);
    this.emit('change', { type: 'remove', id });
  }

  exportData() { return this.list; }

  async importData(list) {
    await this._ready;
    const have = new Set(this.list.map((s) => s.id));
    let added = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      const v = validateSimulation(raw);
      if (v && !have.has(v.id)) { await this.db.put('simulations', v); added += 1; }
    }
    this.list = (await this.db.all('simulations')).map(validateSimulation).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at));
    this.emit('change', { type: 'import' });
    return added;
  }
}
