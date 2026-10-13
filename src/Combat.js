// CypherX AFK - Combat / Grind module
// Kills hostile mobs around the bot, handles creepers with hit-and-retreat,
// equips the best weapon, eats when hungry and drifts back to its spawn spot.
// No extra dependencies: plain mineflayer controls only.

const Vec3 = require('vec3');

const HOSTILE = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'wither_skeleton',
  'spider', 'cave_spider', 'creeper', 'witch', 'slime', 'magma_cube', 'phantom',
  'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'silverfish', 'blaze',
  'ghast', 'hoglin', 'zoglin', 'guardian', 'endermite', 'shulker', 'breeze'
]);

// Never fight these: neutral until provoked, or far too strong for an AFK bot
const NEVER = new Set([
  'enderman', 'zombified_piglin', 'zombie_pigman', 'piglin', 'piglin_brute',
  'iron_golem', 'wolf', 'bee', 'polar_bear', 'llama', 'panda', 'dolphin',
  'warden', 'wither', 'ender_dragon', 'elder_guardian', 'giant'
]);

const WEAPONS = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'
];

const BAD_FOOD = new Set([
  'rotten_flesh', 'spider_eye', 'pufferfish', 'poisonous_potato', 'chorus_fruit',
  'suspicious_stew', 'raw_chicken'
]);

const ARMOR_SLOTS = [
  { slot: 'head', suffix: 'helmet' },
  { slot: 'torso', suffix: 'chestplate' },
  { slot: 'legs', suffix: 'leggings' },
  { slot: 'feet', suffix: 'boots' }
];
const ARMOR_MATERIALS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather'];

// Never let a stuck server response freeze the combat loop
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

class Combat {
  constructor(owner) {
    this.owner = owner;
    this.enabled = true;
    this.range = 16;      // how far away it notices mobs
    this.leash = 32;      // max distance from spawn point it will chase (0 = unlimited)
    this.fleeHealth = 6;  // run away at or below this health (20 = full)
    this.kills = 0;

    this.bot = null;
    this.anchor = null;
    this.target = null;
    this.active = false;  // true while fighting (anti-AFK activity pauses meanwhile)
    this.lastAttack = 0;
    this.retreatUntil = 0;
    this.lastCombatAt = 0;
    this.fleeUntil = 0;
    this.eating = false;
    this.equipping = false;
    this.tickCount = 0;
    this.moving = false;
    this.armorBusy = false;
    this.lastArmorCheck = 0;
    this.warnedNoWeapon = false;
    this.lastTargetId = null;
    this.autoJumping = false;
    this.lastPos = null;
    this.stuckSince = 0;
    this.handlers = [];
  }

  attach(bot) {
    this.detach();
    this.bot = bot;
    this.anchor = null;
    this.target = null;

    const on = (event, fn) => {
      bot.on(event, fn);
      this.handlers.push([event, fn]);
    };

    on('spawn', () => {
      if (bot.entity) this.anchor = bot.entity.position.clone();
      this.warnedNoWeapon = false;
      this.lastArmorCheck = 0;
    });

    on('physicsTick', () => {
      try {
        this.autoJump();
        this.tick();
      } catch (err) {
        console.error(`[CypherX AFK] ${this.owner.username} combat error:`, err.message);
      }
    });

    on('entityDead', (entity) => {
      if (this.target && entity && entity.id === this.target.id) {
        this.kills++;
        this.target = null;
      }
    });

    on('death', () => {
      this.release();
      this.target = null;
    });
  }

  detach() {
    if (this.bot) {
      for (const [event, fn] of this.handlers) this.bot.removeListener(event, fn);
    }
    this.handlers = [];
    this.release();
    this.bot = null;
    this.target = null;
    this.active = false;
  }

  setEnabled(value) {
    this.enabled = !!value;
    if (!this.enabled) {
      this.release();
      this.target = null;
      this.active = false;
    }
    return this.enabled;
  }

  // ---------- helpers ----------
  isHostile(e) {
    if (!e || !e.name || e === this.bot.entity) return false;
    if (NEVER.has(e.name)) return false;
    return e.type === 'hostile' || HOSTILE.has(e.name);
  }

  withinLeash(pos) {
    if (!this.leash || !this.anchor) return true;
    const dx = pos.x - this.anchor.x;
    const dz = pos.z - this.anchor.z;
    return Math.sqrt(dx * dx + dz * dz) <= this.leash;
  }

  release() {
    if (!this.bot) return;
    try {
      if (this.moving) {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('back', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
        this.moving = false;
      }
    } catch (_) {}
  }

  face(pos) {
    try {
      this.bot.lookAt(pos, true);
    } catch (_) {}
  }

  walkToward(pos, sprint = true) {
    const bot = this.bot;
    this.face(pos);
    bot.setControlState('back', false);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', sprint);
    this.moving = true;
  }

  walkAway(from) {
    const bot = this.bot;
    this.face(from); // keep facing the threat while walking backwards
    bot.setControlState('forward', false);
    bot.setControlState('back', true);
    bot.setControlState('sprint', true);
    this.moving = true;
  }

  runAwayBlind(from) {
    // flee in the opposite direction, facing away (faster than walking backwards)
    const bot = this.bot;
    const me = bot.entity.position;
    let dx = me.x - from.x;
    let dz = me.z - from.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= len; dz /= len;
    const away = me.offset(dx * 10, 0, dz * 10); // a point 10 blocks directly away from the threat
    this.face(away);
    bot.setControlState('back', false);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    this.moving = true;
  }

  // ---------- auto jump ----------
  // Runs every physics tick, whenever the bot is walking (combat, fleeing, anti-AFK, gathering):
  // if a solid block is in front at foot level and there is room above it, jump onto it.
  autoJump() {
    const bot = this.bot;
    if (!bot || !bot.entity) return;
    if (bot.pathfinder && bot.pathfinder.goal) return; // pathfinder handles its own jumping
    const st = bot.controlState;
    const walking = st.forward || st.back || st.left || st.right;

    // Stuck detector: pressing a movement key but not actually moving => hop (and nudge sideways)
    const now = Date.now();
    const pos = bot.entity.position;
    if (!walking) {
      this.stuckSince = 0;
    } else {
      if (!this.lastPos || pos.distanceTo(this.lastPos) > 0.08) {
        this.lastPos = pos.clone();
        this.stuckSince = 0;
      } else if (!this.stuckSince) {
        this.stuckSince = now;
      }
    }
    const stuck = walking && this.stuckSince && now - this.stuckSince > 350;

    const wantJump = walking && (this.needsJump() || stuck || bot.entity.isCollidedHorizontally);
    if (wantJump && bot.entity.onGround !== false) {
      if (!st.jump) {
        bot.setControlState('jump', true);
        this.autoJumping = true;
      }
    } else if (this.autoJumping) {
      bot.setControlState('jump', false);
      this.autoJumping = false;
    }
  }

  needsJump() {
    const bot = this.bot;
    const e = bot.entity;
    if (e.isInWater || e.isInLava) return true; // keep afloat / climb out
    if (!e.onGround) return false;

    const st = bot.controlState;
    const yaw = e.yaw;
    // mineflayer: forward = (-sin(yaw), -cos(yaw)); right = (-cos(yaw), sin(yaw))
    let fx = 0, fz = 0;
    if (st.forward) { fx += -Math.sin(yaw); fz += -Math.cos(yaw); }
    if (st.back)    { fx +=  Math.sin(yaw); fz +=  Math.cos(yaw); }
    if (st.left)    { fx +=  Math.cos(yaw); fz += -Math.sin(yaw); }
    if (st.right)   { fx += -Math.cos(yaw); fz +=  Math.sin(yaw); }
    const len = Math.sqrt(fx * fx + fz * fz);
    if (len < 0.001) return false;
    fx /= len; fz /= len;

    const pos = e.position;
    const feetY = Math.floor(pos.y + 0.001);
    const solid = (b) => b && b.boundingBox === 'block';

    // Height of the top of a block's collision box (slabs/stairs/carpet are lower than 1.0)
    const topOf = (b) => {
      if (!solid(b) && !(b && b.shapes && b.shapes.length)) return null;
      const shapes = b.shapes && b.shapes.length ? b.shapes : null;
      const h = shapes ? Math.max(...shapes.map(sh => sh[4])) : 1;
      return b.position.y + h;
    };

    // Jump only when the hitbox is almost touching the block (not a block or two before it).
    // Walking needs a shorter lead than sprinting. Lead is measured from the bot's centre:
    // hitbox half-width (0.3) + a small gap.
    const lead = st.sprint ? 0.72 : 0.58;
    const px = -fz; // sideways vector, so a block in front of the bot's shoulder is noticed too
    const pz = fx;
    let obstacleTop = null;
    let obstacleCol = null;
    for (const side of [0, 0.25, -0.25]) {
      const x = pos.x + fx * lead + px * side;
      const z = pos.z + fz * lead + pz * side;
      const bx = Math.floor(x);
      const bz = Math.floor(z);
      for (const y of [feetY, feetY + 1]) {
        const b = bot.blockAt(new Vec3(bx, y, bz));
        const top = topOf(b);
        if (top !== null && (obstacleTop === null || top > obstacleTop)) {
          obstacleTop = top;
          obstacleCol = { x: bx, z: bz };
        }
      }
    }
    if (obstacleTop === null) return false;

    const rise = obstacleTop - pos.y;
    // Vanilla auto-steps up to 0.6 (slabs, carpet, stairs' first step); a jump reaches ~1.25.
    // Anything taller (fences, walls, 2-high walls) cannot be jumped, so don't bunny-hop at it.
    if (rise <= 0.6 + 0.01 || rise > 1.25) return false;

    // Need room for the body on top of the step and above the bot's own head
    const baseY = Math.ceil(obstacleTop - 0.01);
    const above1 = bot.blockAt(new Vec3(obstacleCol.x, baseY, obstacleCol.z));
    const above2 = bot.blockAt(new Vec3(obstacleCol.x, baseY + 1, obstacleCol.z));
    const headRoom = bot.blockAt(new Vec3(Math.floor(pos.x), feetY + 2, Math.floor(pos.z)));
    return !solid(above1) && !solid(above2) && !solid(headRoom);
  }

  // ---------- inventory ----------
  async ensureWeapon() {
    if (this.equipping || !this.bot) return;
    const bot = this.bot;
    const items = bot.inventory.items();
    let best = null;
    for (const name of WEAPONS) {
      best = items.find(i => i.name === name);
      if (best) break;
    }
    if (!best) return;
    const held = bot.heldItem;
    if (held && held.name === best.name) return;

    this.equipping = true;
    try {
      await withTimeout(bot.equip(best, 'hand'), 5000);
    } catch (_) {
    } finally {
      this.equipping = false;
    }
  }

  hasWeapon() {
    if (!this.bot) return false;
    const names = new Set(this.bot.inventory.items().map(i => i.name));
    return WEAPONS.some(w => names.has(w));
  }

  // Wears the best armor found in the inventory (big reduction in explosion damage)
  async ensureArmor() {
    if (this.armorBusy || !this.bot) return;
    this.armorBusy = true;
    try {
      const bot = this.bot;
      for (const { slot, suffix } of ARMOR_SLOTS) {
        const items = bot.inventory.items();
        let best = null;
        for (const mat of ARMOR_MATERIALS) {
          best = items.find(i => i.name === `${mat}_${suffix}`);
          if (best) break;
        }
        if (!best) continue;
        const slotIndex = { head: 5, torso: 6, legs: 7, feet: 8 }[slot];
        const worn = bot.inventory.slots[slotIndex];
        const wornRank = worn ? ARMOR_MATERIALS.findIndex(m => worn.name.startsWith(m)) : 99;
        const bestRank = ARMOR_MATERIALS.findIndex(m => best.name.startsWith(m));
        if (worn && wornRank !== -1 && wornRank <= bestRank) continue; // already wearing equal/better
        try {
          await withTimeout(bot.equip(best, slot), 5000);
        } catch (_) {}
      }
    } finally {
      this.armorBusy = false;
    }
  }

  findFood() {
    const bot = this.bot;
    const foods = bot.registry && bot.registry.foodsByName;
    if (!foods) return null;
    const candidates = bot.inventory.items().filter(i => foods[i.name] && !BAD_FOOD.has(i.name));
    if (candidates.length === 0) return null;
    // eat the least valuable food first, keep golden apples for emergencies
    candidates.sort((a, b) => (foods[a.name].foodPoints || 0) - (foods[b.name].foodPoints || 0));
    return candidates[0];
  }

  async tryEat() {
    if (this.eating || !this.bot) return;
    const food = this.findFood();
    if (!food) return;
    this.eating = true;
    try {
      await withTimeout(this.bot.equip(food, 'hand'), 5000);
      await withTimeout(this.bot.consume(), 6000);
    } catch (_) {
      try { this.bot.deactivateItem(); } catch (__) {}
    } finally {
      this.eating = false;
    }
  }

  // ---------- main loop ----------
  tick() {
    const bot = this.bot;
    if (!bot || !bot.entity || !this.enabled) return;
    if (++this.tickCount % 3 !== 0) return; // ~every 150 ms
    if (!bot.health || bot.health <= 0) return;
    if (this.eating) return;

    const now = Date.now();
    const me = bot.entity.position;

    if (now - this.lastArmorCheck > 10000) {
      this.lastArmorCheck = now;
      this.ensureArmor().catch(() => {});
    }

    // Find nearby hostile mobs
    const mobs = [];
    for (const e of Object.values(bot.entities)) {
      if (!this.isHostile(e) || !e.position) continue;
      if (Math.abs(e.position.y - me.y) > 8) continue;
      const d = me.distanceTo(e.position);
      if (d > this.range) continue;
      if (!this.withinLeash(e.position) && e.name !== 'creeper') continue;
      mobs.push({ e, d });
    }
    mobs.sort((a, b) => a.d - b.d);

    // CREEPER RULE: never fight a creeper, run away from it until we are well out of its fuse range
    const CREEPER_SAFE = 12;
    const creeper = mobs.find(m => m.e.name === 'creeper' && m.d < CREEPER_SAFE);
    if (creeper) {
      this.target = creeper.e;
      this.active = true;
      this.lastCombatAt = now;
      if (this.lastTargetId !== creeper.e.id) {
        this.lastTargetId = creeper.e.id;
        console.log(`[CypherX AFK] ${this.owner.username} running from creeper (${creeper.d.toFixed(1)} blocks away)`);
      }
      this.runAwayBlind(creeper.e.position);
      return;
    }

    // Everything else is fought; creepers that are far away are simply ignored
    const pick = mobs.find(m => m.e.name !== 'creeper');

    if (!pick) {
      this.target = null;
      this.active = false;

      // Hungry and nothing around: eat
      if (bot.food !== undefined && bot.food <= 14 && !mobs.length) {
        this.release();
        this.tryEat();
        return;
      }

      // Drift back to the spawn spot after a fight (but not while a creeper is lurking)
      const gathering = this.owner.gatherer && this.owner.gatherer.busy;
      if (this.anchor && !gathering && !mobs.length && now - this.lastCombatAt < 15000) {
        const dx = this.anchor.x - me.x;
        const dz = this.anchor.z - me.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 4) {
          this.walkToward(this.anchor.offset(0, 0, 0), false);
          return;
        }
      }
      this.release();
      return;
    }

    const target = pick.e;
    const dist = pick.d;
    if (this.lastTargetId !== target.id) {
      this.lastTargetId = target.id;
      console.log(`[CypherX AFK] ${this.owner.username} engaging ${target.name} (${dist.toFixed(1)} blocks away)`);
    }
    this.target = target;
    this.active = true;
    this.lastCombatAt = now;

    // Make sure we hold the best weapon
    this.ensureWeapon();

    const center = target.position.offset(0, (target.height || 1.6) * 0.7, 0);

    // Low health: run, don't fight
    if (bot.health <= this.fleeHealth || now < this.fleeUntil) {
      if (bot.health <= this.fleeHealth) this.fleeUntil = now + 3000;
      this.runAwayBlind(target.position);
      return;
    }

    // Every other mob: chase and melee
    const dy = target.position.y - me.y;
    const dxz = Math.hypot(target.position.x - me.x, target.position.z - me.z);
    // keep walking (and hopping) while the mob is on higher ground or not yet close horizontally
    if (dist > 2.6 || dy > 0.9 || (dxz > 1.8 && dy < -0.9)) {
      this.walkToward(target.position, true);
    } else {
      // close enough: stop pushing forward so we don't run past it
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      this.face(center);
    }

    if (dist <= 3.1 && now - this.lastAttack >= 650) {
      this.face(center);
      bot.attack(target);
      this.lastAttack = now;
    }
  }
}

module.exports = Combat;
