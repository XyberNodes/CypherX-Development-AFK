// CypherX AFK - Gatherer module
// Chops trees (and replants saplings), gathers common blocks, and crafts items
// (planks, sticks, crafting table, tools, chests, ...). Uses mineflayer-pathfinder.
//
// Safety: only chops NATURAL trees (logs with leaves around them), only gathers blocks from a
// whitelist, never breaks chests/builds, and the pathfinder is not allowed to dig or place blocks.

const { E } = require('./emojis');

let pf = null;
try { pf = require('mineflayer-pathfinder'); } catch (_) { /* optional until npm install */ }
let Vec3 = null;
try { Vec3 = require('vec3').Vec3; } catch (_) {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })
  ]).finally(() => clearTimeout(timer));
}

const posKey = (p) => `${p.x},${p.y},${p.z}`;

// Blocks the `gather` command is allowed to break
const GATHER_ALLOWED = /^(stone|cobblestone|dirt|grass_block|coarse_dirt|sand|red_sand|gravel|clay|andesite|diorite|granite|sandstone|netherrack|deepslate|cobbled_deepslate|sugar_cane|pumpkin|melon|cactus|bamboo|[a-z_]+_ore|[a-z_]+_log)$/;

const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
const CRAFT_TIERS = ['wooden', 'stone', 'iron', 'diamond']; // cheapest first
const GROUND_FOR_SAPLING = new Set(['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt', 'moss_block', 'mud']);

class Gatherer {
  constructor(owner) {
    this.owner = owner;
    this.available = !!pf;
    this.bot = null;
    this.task = null;
    this.running = false;
    this.token = 0;
    this.blacklist = new Set();
    this.naturalCache = new Map();
    this.toolTried = new Map();
    this.treeBase = null;
    this.treeSpecies = null;
    this.handlers = [];
    this.movementsReady = false;
  }

  get busy() {
    return this.running && !!this.task;
  }

  describe() {
    const t = this.task;
    if (!t) return 'Idle';
    if (t.type === 'craft') return `Crafting ${t.item} x${t.count}`;
    const what = t.type === 'wood' ? 'Chopping wood' : `Gathering ${t.block}`;
    const goal = t.count > 0 ? `${t.progress}/${t.count}` : `${t.progress} so far (continuous)`;
    return `${what} (${goal})`;
  }

  // ---------- lifecycle ----------
  attach(bot) {
    this.detach();
    if (!this.available) return;
    this.bot = bot;
    this.movementsReady = false;

    bot.loadPlugin(pf.pathfinder);

    const on = (event, fn) => { bot.on(event, fn); this.handlers.push([event, fn]); };

    bot.once('spawn', () => {
      try {
        const movements = new pf.Movements(bot);
        movements.canDig = false;              // never tunnel through the world
        movements.allow1by1towers = false;     // never place blocks to climb
        movements.allowParkour = false;
        movements.scafoldingBlocks = [];       // (sic) pathfinder's own spelling
        movements.scaffoldingBlocks = [];
        bot.pathfinder.setMovements(movements);
        this.movementsReady = true;
      } catch (err) {
        console.error(`[CypherX AFK] ${this.owner.username} pathfinder setup failed:`, err.message);
        return;
      }
      if (this.task && !this.running) this.run();
    });

    // Combat always wins: drop any path as soon as a fight starts
    on('physicsTick', () => {
      try {
        if (this.owner.combat && this.owner.combat.active && bot.pathfinder && bot.pathfinder.goal) {
          bot.pathfinder.setGoal(null);
        }
      } catch (_) {}
    });
  }

  detach() {
    this.token++;
    this.running = false;
    if (this.bot) {
      for (const [event, fn] of this.handlers) this.bot.removeListener(event, fn);
      try { if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null); } catch (_) {}
    }
    this.handlers = [];
    this.bot = null;
    this.movementsReady = false;
  }

  clearTask() {
    this.task = null;
    this.token++;
    this.running = false;
    this.treeBase = null;
    try { if (this.bot && this.bot.pathfinder) this.bot.pathfinder.setGoal(null); } catch (_) {}
  }

  setTask(spec) {
    if (!this.available) {
      return { ok: false, message: 'Gathering needs the `mineflayer-pathfinder` package. Run `npm install` on the host and restart the bot.' };
    }

    const task = { type: spec.type, count: spec.count || 0, progress: 0, idle: 0, auto: !!spec.auto, startedAt: Date.now() };

    if (spec.type === 'gather') {
      const name = String(spec.block || '').toLowerCase().replace(/\s+/g, '_');
      if (!GATHER_ALLOWED.test(name)) {
        return { ok: false, message: `\`${name}\` can't be gathered. Allowed: logs, stone, cobblestone, dirt, sand, gravel, clay, ores, sugar cane, pumpkin, melon, cactus, bamboo.` };
      }
      task.block = name;
    } else if (spec.type === 'craft') {
      task.item = String(spec.item || '').toLowerCase().replace(/\s+/g, '_');
      task.count = Math.max(1, spec.count || 1);
    }

    this.clearTask();
    this.blacklist.clear();
    this.naturalCache.clear();
    this.toolTried.clear();
    this.task = task;

    if (this.bot && this.owner.isConnected && this.movementsReady) this.run();
    const connectedNote = this.owner.isConnected ? '' : ' It will start as soon as the bot joins the server.';
    return { ok: true, message: `${this.describe()} started.${connectedNote}` };
  }

  finish(reason, ok = true) {
    const t = this.task;
    if (!t) return;
    this.owner.log(
      ok ? `Task Complete ${E.CHECK}` : `Task Stopped ${E.CAUTION}`,
      `${this.describe()} - ${reason}`,
      ok ? '#57F287' : '#FEE75C'
    );
    this.task = null;
    this.treeBase = null;
    try { if (this.bot && this.bot.pathfinder) this.bot.pathfinder.setGoal(null); } catch (_) {}
  }

  alive(token) {
    return this.bot && this.owner.isConnected && token === this.token && this.task;
  }

  // ---------- main loop ----------
  async run() {
    if (this.running || !this.task || !this.bot) return;
    this.running = true;
    const token = ++this.token;
    let errorStreak = 0;

    try {
      while (this.alive(token)) {
        const combat = this.owner.combat;
        if (combat && combat.active) {          // a fight is going on: wait
          await sleep(400);
          continue;
        }
        if (this.bot.health !== undefined && this.bot.health <= 0) {
          await sleep(1000);
          continue;
        }

        try {
          if (this.task.type === 'craft') await this.craftStep(token);
          else await this.gatherStep(token);
          errorStreak = 0;
        } catch (err) {
          errorStreak++;
          if (errorStreak >= 8 && this.task) {
            this.finish(`Too many errors (${err.message})`, false);
            break;
          }
        }
        await sleep(120);
      }
    } finally {
      if (token === this.token) this.running = false;
    }
  }

  // ---------- gathering ----------
  resolveTargets(task) {
    const reg = this.bot.registry;
    if (task.type === 'wood') {
      return Object.values(reg.blocksByName)
        .filter(b => /_log$/.test(b.name) && !b.name.startsWith('stripped_'))
        .map(b => b.id);
    }
    const b = reg.blocksByName[task.block];
    return b ? [b.id] : [];
  }

  isNatural(block) {
    const k = posKey(block.position);
    if (this.naturalCache.has(k)) return this.naturalCache.get(k);
    let natural = false;
    const p = block.position;
    outer:
    for (let dy = 0; dy <= 6; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const b = this.bot.blockAt(p.offset(dx, dy, dz));
          if (b && b.name.endsWith('_leaves')) { natural = true; break outer; }
        }
      }
    }
    this.naturalCache.set(k, natural);
    return natural;
  }

  findTarget(ids, task) {
    // Nearest candidates first, then run the (costlier) checks only until one passes.
    const radii = task.type === 'wood' ? [24, 48] : [32];
    for (const maxDistance of radii) {
      const positions = this.bot.findBlocks({ matching: ids, maxDistance, count: 48 });
      for (const pos of positions) {
        if (this.blacklist.has(posKey(pos))) continue;
        const block = this.bot.blockAt(pos);
        if (!block) continue;
        if (/_log$/.test(block.name) && !this.isNatural(block)) continue; // never chop player builds
        return block;
      }
    }
    return null;
  }

  nearLava(block) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = this.bot.blockAt(block.position.offset(dx, dy, dz));
      if (n && n.name === 'lava') return true;
    }
    return false;
  }

  async gatherStep(token) {
    const bot = this.bot;
    const task = this.task;

    if (task.count > 0 && task.progress >= task.count) {
      await this.finishTree(token);
      return this.finish('Target reached.');
    }
    if (bot.inventory.emptySlotCount() <= 1) {
      await this.finishTree(token);
      return this.finish('Inventory is full.', false);
    }

    const ids = this.resolveTargets(task);
    if (ids.length === 0) return this.finish(`Unknown block \`${task.block}\`.`, false);

    // keep the combat leash centred on where we are working
    if (this.owner.combat && bot.entity) this.owner.combat.anchor = bot.entity.position.clone();

    const block = this.findTarget(ids, task);
    if (!block) {
      await this.finishTree(token);
      task.idle++;
      if (task.idle >= 3) {
        if (task.auto || task.type === 'wood') {
          await this.wander(token);       // look for more trees elsewhere
          task.idle = 0;
          if (!task.auto && task.type === 'wood' && task.count > 0 && task.progress === 0) {
            return this.finish('No natural trees found nearby.', false);
          }
        } else {
          return this.finish('No more of that block found nearby.', false);
        }
      }
      await sleep(800);
      return;
    }
    task.idle = 0;

    // moved on to a different tree: replant the previous one first
    if (task.type === 'wood' && this.treeBase) {
      const dx = block.position.x - this.treeBase.x;
      const dz = block.position.z - this.treeBase.z;
      if (Math.sqrt(dx * dx + dz * dz) > 5) await this.finishTree(token);
    }

    if (this.nearLava(block)) {
      this.blacklist.add(posKey(block.position));
      return;
    }

    // block directly under our feet: don't dig ourselves into a hole
    const me = bot.entity.position;
    if (block.position.y < Math.floor(me.y) &&
        Math.abs(block.position.x + 0.5 - me.x) < 1 && Math.abs(block.position.z + 0.5 - me.z) < 1) {
      this.blacklist.add(posKey(block.position));
      return;
    }

    const toolOk = await this.ensureToolFor(block, task);
    if (!this.task) return;
    if (toolOk === false) return;

    try {
      if (me.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 3.5) {
        await this.goNear(block.position, 2);
      }
    } catch (_) {
      this.blacklist.add(posKey(block.position));
      return;
    }
    if (!this.alive(token)) return;

    const target = bot.blockAt(block.position);
    if (!target || !ids.includes(target.type)) return; // already gone
    if (!bot.canDigBlock(target)) {
      this.blacklist.add(posKey(block.position));
      return;
    }

    await this.equipBest(target);
    try {
      await withTimeout(bot.dig(target, true), 25000);
    } catch (_) {
      this.blacklist.add(posKey(block.position));
      return;
    }

    task.progress++;
    if (task.type === 'wood') {
      const species = target.name.replace(/_log$/, '');
      if (!this.treeBase || target.position.y < this.treeBase.y) {
        this.treeBase = target.position.clone();
        this.treeSpecies = species;
      }
    }
    await this.collectDrops(token);
  }

  async wander(token) {
    if (!this.alive(token) || !pf) return;
    const me = this.bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const dist = 18 + Math.random() * 12;
    const goal = new pf.goals.GoalXZ(Math.floor(me.x + Math.cos(angle) * dist), Math.floor(me.z + Math.sin(angle) * dist));
    try {
      await withTimeout(this.bot.pathfinder.goto(goal), 20000);
    } catch (_) {
      try { this.bot.pathfinder.setGoal(null); } catch (__) {}
    }
  }

  async goNear(pos, range) {
    const goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, range);
    try {
      await withTimeout(this.bot.pathfinder.goto(goal), 25000);
    } catch (err) {
      try { this.bot.pathfinder.setGoal(null); } catch (_) {}
      throw err;
    }
  }

  async collectDrops(token) {
    const tried = new Set();
    for (let i = 0; i < 4 && this.alive(token); i++) {
      const me = this.bot.entity.position;
      let best = null;
      let bestDist = 8;
      for (const e of Object.values(this.bot.entities)) {
        if (!e.position || tried.has(e.id)) continue;
        if (e.name !== 'item' && e.objectType !== 'Item') continue;
        const d = me.distanceTo(e.position);
        if (d < bestDist) { best = e; bestDist = d; }
      }
      if (!best) break;
      tried.add(best.id);
      try {
        await withTimeout(this.bot.pathfinder.goto(new pf.goals.GoalNear(best.position.x, best.position.y, best.position.z, 1)), 8000);
      } catch (_) {
        try { this.bot.pathfinder.setGoal(null); } catch (__) {}
      }
      await sleep(150);
    }
  }

  // Replant a sapling where the tree stood (best effort)
  async finishTree(token) {
    const base = this.treeBase;
    const species = this.treeSpecies;
    this.treeBase = null;
    if (!base || !Vec3 || !this.alive(token)) return;

    await this.collectDrops(token);

    try {
      const sapling = this.bot.inventory.items().find(i => i.name === `${species}_sapling`);
      if (!sapling) return;
      const ground = this.bot.blockAt(base.offset(0, -1, 0));
      const spot = this.bot.blockAt(base);
      if (!ground || !spot || !GROUND_FOR_SAPLING.has(ground.name) || spot.name !== 'air') return;

      const me = this.bot.entity.position;
      if (me.distanceTo(base.offset(0.5, 0.5, 0.5)) > 4) await this.goNear(base, 2);
      await withTimeout(this.bot.equip(sapling, 'hand'), 4000);
      await withTimeout(this.bot.placeBlock(ground, new Vec3(0, 1, 0)), 5000);
    } catch (_) {
      /* replanting is optional */
    }
  }

  // ---------- tools ----------
  toolTypeFor(block) {
    const n = block.name;
    if (/_log$|_wood$|_planks$/.test(n)) return 'axe';
    if (/stone|cobble|_ore$|deepslate|netherrack|sandstone|andesite|diorite|granite|obsidian/.test(n)) return 'pickaxe';
    if (/dirt|sand|gravel|clay|grass_block|mud|podzol/.test(n)) return 'shovel';
    const m = block.material || '';
    if (m.includes('mineable/pickaxe')) return 'pickaxe';
    if (m.includes('mineable/axe')) return 'axe';
    if (m.includes('mineable/shovel')) return 'shovel';
    return null;
  }

  bestOwnedTool(type) {
    const items = this.bot.inventory.items();
    for (const tier of TIERS) {
      const found = items.find(i => i.name === `${tier}_${type}`);
      if (found) return found;
    }
    return null;
  }

  async equipBest(block) {
    const type = this.toolTypeFor(block);
    if (!type) return;
    const tool = this.bestOwnedTool(type);
    if (!tool) return;
    if (this.bot.heldItem && this.bot.heldItem.name === tool.name) return;
    try {
      await withTimeout(this.bot.equip(tool, 'hand'), 4000);
    } catch (_) {}
  }

  // Returns false if the block cannot be harvested yet (and the step should be skipped)
  async ensureToolFor(block, task) {
    const type = this.toolTypeFor(block);
    if (!type) return true;

    if (!this.bestOwnedTool(type)) {
      const last = this.toolTried.get(type) || 0;
      if (Date.now() - last > 90000) {
        this.toolTried.set(type, Date.now());
        try {
          await this.craftBestTool(type, block);
        } catch (err) {
          if (type !== 'axe' && type !== 'shovel') {
            this.owner.log(`Task Notice ${E.CAUTION}`, `Could not craft a ${type}: ${err.message}`, '#FEE75C');
          }
        }
      }
    }

    // does the block actually drop with what we hold?
    if (block.harvestTools) {
      const ok = this.bot.inventory.items().some(i => block.harvestTools[i.type]);
      if (!ok) {
        if (task.type === 'gather') {
          this.finish(`A better ${type} is needed to harvest \`${block.name}\`.`, false);
        } else {
          this.blacklist.add(posKey(block.position));
        }
        return false;
      }
    }
    return true;
  }

  async craftBestTool(type, block) {
    const reg = this.bot.registry;
    let lastErr = new Error('no recipe');
    for (const tier of CRAFT_TIERS) {
      const item = reg.itemsByName[`${tier}_${type}`];
      if (!item) continue;
      if (block && block.harvestTools && !block.harvestTools[item.id]) continue;
      try {
        await this.produce(item.id, 1, 3);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // ---------- crafting ----------
  invMap() {
    const m = new Map();
    for (const it of this.bot.inventory.items()) m.set(it.type, (m.get(it.type) || 0) + it.count);
    return m;
  }

  ingredientsOf(recipe) {
    return (recipe.delta || []).filter(d => d.count < 0).map(d => ({ id: d.id, count: -d.count }));
  }

  // Simulates taking `qty` of item `id` from inventory + crafting the rest. Mutates `inv`.
  take(id, qty, inv, depth) {
    const have = inv.get(id) || 0;
    const use = Math.min(have, qty);
    inv.set(id, have - use);
    const need = qty - use;
    if (need <= 0) return true;
    if (depth <= 0) return false;

    for (const recipe of this.sortedRecipes(id)) {
      const per = (recipe.result && recipe.result.count) || 1;
      const times = Math.ceil(need / per);
      const trial = new Map(inv);
      let ok = true;
      for (const ing of this.ingredientsOf(recipe)) {
        if (!this.take(ing.id, ing.count * times, trial, depth - 1)) { ok = false; break; }
      }
      if (ok) {
        for (const [k, v] of trial) inv.set(k, v);
        inv.set(id, (inv.get(id) || 0) + per * times - need);
        return true;
      }
    }
    return false;
  }

  sortedRecipes(id) {
    const all = this.bot.recipesAll(id, null, true) || [];
    return all.slice().sort((a, b) => Number(!!a.requiresTable) - Number(!!b.requiresTable));
  }

  // Makes sure the inventory ends up with at least `qty` of item `id` (crafting intermediates too)
  async produce(id, qty, depth = 3) {
    const reg = this.bot.registry;
    const name = reg.items[id] ? reg.items[id].name : String(id);
    const have = this.invMap().get(id) || 0;
    if (have >= qty) return;
    const need = qty - have;
    if (depth <= 0) throw new Error(`cannot craft ${name}: recipe too deep`);

    for (const recipe of this.sortedRecipes(id)) {
      const per = (recipe.result && recipe.result.count) || 1;
      const times = Math.ceil(need / per);
      const trial = this.invMap();
      const ingredients = this.ingredientsOf(recipe);
      if (!ingredients.every(ing => this.take(ing.id, ing.count * times, trial, depth - 1))) continue;

      // feasible: first make every ingredient, then craft this item.
      // Crafting one ingredient (e.g. sticks) can eat another (planks), so verify and repeat.
      for (let pass = 0; pass < 4; pass++) {
        let allReady = true;
        for (const ing of ingredients) {
          const want = ing.count * times;
          if ((this.invMap().get(ing.id) || 0) < want) {
            allReady = false;
            await this.produce(ing.id, want, depth - 1);
          }
        }
        if (allReady) break;
      }
      const finalInv = this.invMap();
      if (!ingredients.every(ing => (finalInv.get(ing.id) || 0) >= ing.count * times)) {
        throw new Error(`missing materials for ${name}`);
      }
      let table = null;
      if (recipe.requiresTable) table = await this.getCraftingTable();
      await withTimeout(this.bot.craft(recipe, times, table), 15000);
      return;
    }
    throw new Error(`missing materials for ${name}`);
  }

  async getCraftingTable() {
    const bot = this.bot;
    const reg = bot.registry;
    const tableId = reg.blocksByName.crafting_table.id;

    let table = bot.findBlock({ matching: tableId, maxDistance: 20 });
    if (!table) {
      await this.produce(reg.itemsByName.crafting_table.id, 1, 3);
      table = await this.placeCraftingTable();
    }
    if (!table) throw new Error('could not find or place a crafting table');

    if (bot.entity.position.distanceTo(table.position.offset(0.5, 0.5, 0.5)) > 4) {
      await this.goNear(table.position, 2);
    }
    return table;
  }

  async placeCraftingTable() {
    if (!Vec3) throw new Error('vec3 package missing (run npm install)');
    const bot = this.bot;
    const item = bot.inventory.items().find(i => i.name === 'crafting_table');
    if (!item) return null;
    await withTimeout(bot.equip(item, 'hand'), 4000);

    const feet = bot.entity.position.floored();
    const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    for (const [dx, dz] of offsets) {
      const ground = bot.blockAt(feet.offset(dx, -1, dz));
      const above = bot.blockAt(feet.offset(dx, 0, dz));
      const head = bot.blockAt(feet.offset(dx, 1, dz));
      if (!ground || ground.boundingBox !== 'block' || !above || above.name !== 'air' || !head || head.name !== 'air') continue;
      try {
        await withTimeout(bot.placeBlock(ground, new Vec3(0, 1, 0)), 5000);
        await sleep(300);
        const placed = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 6 });
        if (placed) return placed;
      } catch (_) {}
    }
    return null;
  }

  async craftStep(token) {
    const task = this.task;
    const reg = this.bot.registry;
    const item = reg.itemsByName[task.item];
    if (!item) return this.finish(`Unknown item \`${task.item}\`.`, false);

    if (this.owner.combat && this.bot.entity) this.owner.combat.anchor = this.bot.entity.position.clone();

    const have = this.invMap().get(item.id) || 0;
    try {
      await this.produce(item.id, have + task.count, 3);
      task.progress = task.count;
      this.finish(`Crafted ${task.item}.`);
    } catch (err) {
      this.finish(`Could not craft: ${err.message}.`, false);
    }
  }
}

module.exports = Gatherer;
