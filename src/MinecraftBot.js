const mineflayer = require('mineflayer');
const { E } = require('./emojis');
const Combat = require('./Combat');
const Gatherer = require('./Gatherer');

class MinecraftBot {
  constructor(ownerId, username, host, port, version = null, password = null, useAuthPlugin = true, logCallback = null, updatePanelCallback = null) {
    this.ownerId = ownerId;
    this.username = username;
    this.host = host;
    this.port = parseInt(port, 10) || 25565;
    
    // Validate custom version string; fall back to 1.20.1 if invalid or empty
    this.version = (version && typeof version === 'string' && version.trim() !== '' && version.trim() !== '26.1.2') 
      ? version.trim() 
      : '1.20.1';
    
    this.password = password;
    this.useAuthPlugin = useAuthPlugin;

    this.bot = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectTimer = null;
    this.autoChatInterval = null;

    // Anti-AFK activity (jump / walk / sneak) roughly once a minute
    this.activityEnabled = true;
    this.activityIntervalMs = 60 * 1000;
    this.activityTimer = null;
    this.activityRunning = false;

    this.autoChatMessage = 'I am AFK using CypherX AFK!';
    this.autoChatIntervalMinutes = 1;
    this.autoChatEnabled = true; // Enabled automatically by default

    this.logCallback = logCallback;
    this.updatePanelCallback = updatePanelCallback;
    this.suppressReconnectLog = false;
    this.noReconnect = false; // set when banned / not whitelisted

    // Combat / grind (kills hostile mobs, handles creepers)
    this.combat = new Combat(this);

    // Chop wood / gather blocks / craft items
    this.gatherer = new Gatherer(this);

    // 24/7 stability
    this.stopped = false;          // true after the user presses Stop
    this.reconnectAttempts = 0;    // drives exponential back-off

    // Auto register / login state
    this.passwordGenerated = false;
    this.authEmail = `${username.toLowerCase()}@gmail.com`; // used only if a server asks for an email on /register
    this.authState = null;
    this.authTimers = new Set();
    this.resetAuth();
  }

  // ---------- Auto Register / Login ----------
  resetAuth() {
    this.clearAuthTimers();
    this.authState = {
      done: false,
      failed: false,
      registerSent: 0,
      loginSent: 0,
      lastSentAt: 0,
      lastAction: null
    };
  }

  clearAuthTimers() {
    for (const t of this.authTimers) clearTimeout(t);
    this.authTimers.clear();
  }

  authDelay(fn, ms) {
    const t = setTimeout(() => {
      this.authTimers.delete(t);
      fn();
    }, ms);
    this.authTimers.add(t);
  }

  generatePassword() {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  ensurePassword() {
    if (this.password) return;
    this.password = this.generatePassword();
    this.passwordGenerated = true;
    this.log(
      `Auto Password Generated ${E.WARN}`,
      `The server asked for a login but no password was set, so one was generated: \`${this.password}\`. Save it if you ever need to log in manually.`,
      '#FEE75C'
    );
  }

  /** Counts <placeholders> in a "/register <a> <b>" usage line. */
  parseRegisterArgs(msg) {
    const m = msg.match(/\/(?:register|reg)\b((?:\s+[<\[][^>\]]*[>\]])*)/i);
    const placeholders = m && m[1] ? (m[1].match(/[<\[][^>\]]*[>\]]/g) || []) : [];
    const wantsEmail = placeholders.some(p => /mail/i.test(p));
    const pwCount = placeholders.filter(p => !/mail/i.test(p)).length;
    return { pwCount: pwCount === 0 ? 2 : Math.min(pwCount, 2), wantsEmail };
  }

  sendAuth(action, rawMsg = '') {
    const st = this.authState;
    if (!this.bot || st.done || st.failed) return;

    const now = Date.now();
    if (now - st.lastSentAt < 2500) return; // cooldown, avoids spamming / loops

    if (action === 'register') {
      if (st.registerSent >= 4) return this.failAuth('Too many register attempts without success.');
      this.ensurePassword();
      const { pwCount, wantsEmail } = this.parseRegisterArgs(rawMsg);
      let cmd = `/register ${this.password}`;
      if (pwCount >= 2) cmd += ` ${this.password}`;
      if (wantsEmail) cmd += ` ${this.authEmail}`;
      st.registerSent++;
      st.lastSentAt = now;
      st.lastAction = 'register';
      this.authDelay(() => { if (this.bot && !st.done) this.bot.chat(cmd); }, 800 + Math.random() * 600);
    } else {
      if (st.loginSent >= 4) return this.failAuth('Too many login attempts without success.');
      this.ensurePassword();
      st.loginSent++;
      st.lastSentAt = now;
      st.lastAction = 'login';
      this.authDelay(() => { if (this.bot && !st.done) this.bot.chat(`/login ${this.password}`); }, 800 + Math.random() * 600);
    }
  }

  failAuth(reason) {
    if (this.authState.failed) return;
    this.authState.failed = true;
    this.clearAuthTimers();
    this.log(`Auto Login Failed ${E.CROSS}`, `${reason} Check the password and press Start again.`, '#ED4245');
  }

  handleAuthMessage(message) {
    const st = this.authState;
    if (!st || st.done || st.failed) return;
    const msg = String(message).replace(/§./g, '').trim();
    if (!msg) return;

    const SUCCESS = /(successful(ly)?\s*(logged|login|registered|authenticated|log in)|logged in successfully|login successful|registration successful|registered successfully|you (are|have been)( now)? (logged in|registered|authenticated)|welcome back|erfolgreich)/i;
    const NEGATED = /(not|n't|never)\s+(yet\s+)?(logged|registered|authenticated)/i;
    const WRONG_PASS = /(wrong|incorrect|invalid)\s+password|password\s+(is\s+)?(wrong|incorrect|invalid)|falsches passwort/i;
    const ALREADY_REG = /already\s+(registered|regist)|bereits registriert|has already been registered/i;
    const NOT_REG = /(not|isn't|aren't)\s+(yet\s+)?registered|(must|need to|have to)\s+register|nicht registriert/i;
    const REGISTER_PROMPT = /\/(register|reg)\b|please\s+register|register\s+(with|using|your|an account|first)|registriere/i;
    const LOGIN_PROMPT = /\/(login|log|l)\b|please\s+(log\s?in)|log\s?in\s+(with|using|to|first)|login\s+(with|using|first)|bitte.*(login|anmelden)/i;

    if (SUCCESS.test(msg) && !NEGATED.test(msg)) {
      st.done = true;
      this.clearAuthTimers();
      this.log(
        `Auto ${st.lastAction === 'register' ? 'Register' : 'Login'} Success ${E.CHECK}`,
        st.lastAction === 'register'
          ? `Bot account \`${this.username}\` was registered and logged in automatically.`
          : `Bot account \`${this.username}\` logged in automatically.`,
        '#57F287'
      );
      return;
    }

    if (WRONG_PASS.test(msg)) {
      return this.failAuth('The server says the password is wrong.');
    }

    if (ALREADY_REG.test(msg)) return this.sendAuth('login', msg);
    if (NOT_REG.test(msg)) return this.sendAuth('register', msg);

    const wantsLogin = LOGIN_PROMPT.test(msg);
    const wantsRegister = REGISTER_PROMPT.test(msg);

    // If a message mentions both, try login first; the server's reply tells us to register if needed.
    if (wantsLogin) return this.sendAuth('login', msg);
    if (wantsRegister) return this.sendAuth('register', msg);
  }

  /** Replies when a player says "cypher <something>" (or the bot's own name) in chat. */
  handlePlayerChat(username, message) {
    if (!this.bot || !this.isConnected) return;
    if (!username || username === this.bot.username) return;

    const name = String(this.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^\\s*(?:hey\\s+|hi\\s+|yo\\s+)?(?:cypherx?${name ? `|${name}` : ''})\\b[\\s,:!.-]*(.*)$`, 'i').exec(String(message || ''));
    if (!match) return;

    // Cooldown per player so the bot never spams chat
    this.chatCooldowns = this.chatCooldowns || new Map();
    const now = Date.now();
    if (now - (this.chatCooldowns.get(username) || 0) < 4000) return;
    this.chatCooldowns.set(username, now);

    const text = match[1].trim().toLowerCase();
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    let reply;

    if (!text || /^(hi|hii+|hello|hey+|heya|yo|sup|hola|howdy|wassup|what'?s up)\b/.test(text)) {
      reply = pick([`Hey ${username}!`, `Hello ${username}!`, `Hi ${username}, what's up?`]);
    } else if (/how\s*(are|r)\s*(you|u)|hru|how'?s it going/.test(text)) {
      reply = pick(["I'm good, just chilling here. You?", 'Doing great, thanks for asking!']);
    } else if (/who\s*(are|r)\s*(you|u)|what\s*(are|r)\s*(you|u)|are you a bot/.test(text)) {
      reply = "I'm CypherX AFK, a Minecraft AFK bot.";
    } else if (/thank|thx|ty\b/.test(text)) {
      reply = pick(['No problem!', 'Anytime!', 'You got it!']);
    } else if (/^(bye|goodbye|cya|see ya|gtg|gn|good night)\b/.test(text)) {
      reply = pick([`Bye ${username}!`, `See you later, ${username}!`]);
    } else if (/good\s*(morning|afternoon|evening)/.test(text)) {
      reply = `Hello ${username}, hope you're doing well!`;
    } else {
      reply = pick([`Yes ${username}?`, `I'm an AFK bot, so I can't chat much, ${username}.`, `Hey ${username}, I'm here!`]);
    }

    setTimeout(() => {
      try { if (this.bot && this.isConnected) this.bot.chat(reply); } catch (_) {}
    }, 800 + Math.random() * 700);
  }

  log(action, description, color = '#5865F2') {
    // Only "Bot Joined" and "Bot Disconnected" are posted to the log channel.
    // Everything else (creepers, deaths, tasks, auth, etc.) is silenced.
    if (!/^Bot (Joined|Disconnected)/.test(action)) return;
    if (this.logCallback) {
      this.logCallback({
        user: `<@${this.ownerId}>`,
        botName: this.username,
        server: `${this.host}:${this.port}`,
        action,
        description,
        color
      });
    }
  }

  triggerPanelUpdate() {
    if (this.updatePanelCallback) {
      this.updatePanelCallback();
    }
  }

  start() {
    if (this.isConnected || this.isConnecting) return false;

    this.isConnecting = true;
    this.noReconnect = false;
    this.stopped = false;
    this.triggerPanelUpdate();

    try {
      const options = {
        host: this.host,
        port: this.port,
        username: this.username,
        version: this.version,
        hideErrors: false,
        checkTimeoutInterval: 60 * 1000
      };

      this.bot = mineflayer.createBot(options);
      this.combat.attach(this.bot);
      this.gatherer.attach(this.bot);
      this.setupEvents();
      return true;
    } catch (err) {
      this.isConnecting = false;
      this.triggerPanelUpdate();
      return false;
    }
  }

  setupEvents() {
    if (this.bot._client) {
      this.bot._client.on('error', (err) => {
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
          this.handleConnectionFailure(err.code);
        }
      });
    }

    this.bot.once('spawn', () => {
      this.isConnected = true;
      this.isConnecting = false;
      this.suppressReconnectLog = false;
      this.reconnectAttempts = 0;
      this.triggerPanelUpdate();

      this.log(
        `Bot Joined Server ${E.CHECK}`,
        `Successfully connected and spawned on \`${this.host}:${this.port}\`.`,
        '#57F287'
      );

      // Fallback: if the user said the server has an auth plugin but no prompt shows up, try /login once
      if (this.useAuthPlugin && this.password) {
        this.authDelay(() => {
          if (this.bot && this.isConnected && !this.authState.done && this.authState.loginSent === 0 && this.authState.registerSent === 0) {
            this.sendAuth('login');
          }
        }, 6000);
      }

      // Automatically start messaging loop
      if (this.autoChatEnabled) {
        this.startAutoChat();
      }

      // Start anti-AFK movement (jump / walk / sneak)
      this.startActivity();
    });

    // New world / proxy server switch: auth must be checked again
    this.bot.on('login', () => this.resetAuth());

    // Auto register / login for AuthMe, LoginSecurity, nLogin, OpenLogin, etc.
    this.bot.on('messagestr', (message, position, jsonMsg, sender) => {
      if (sender) return; // ignore real player chat, only react to server/system messages
      this.handleAuthMessage(message);
    });

    // In-game chat: reply when a player talks to the bot, e.g. "cypher hi"
    this.bot.on('chat', (username, message) => this.handlePlayerChat(username, message));

    this.bot.on('kicked', (reason) => {
      const parsedReason = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
      console.error(`[CypherX AFK] ${this.username} kicked:`, parsedReason);
      this.log(
        `Bot Disconnected ${E.CROSS}`,
        `Kicked from \`${this.host}:${this.port}\` (Reason: \`${parsedReason}\`).`,
        '#ED4245'
      );

      // Banned or not whitelisted: retrying only spams the server, so stop auto-reconnecting
      if (/banned|whitelist/i.test(parsedReason)) {
        this.noReconnect = true;
        this.suppressReconnectLog = true;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.log(
          `Auto-Reconnect Stopped ${E.WARN}`,
          'The server banned this bot or it is not whitelisted, so auto-reconnect was turned off. Fix it on the server, then press Start.',
          '#FEE75C'
        );
        return;
      }

      if (/wrong password|incorrect password|invalid password/i.test(parsedReason)) {
        this.noReconnect = true;
        this.suppressReconnectLog = true;
        this.log(
          `Auto-Reconnect Stopped ${E.WARN}`,
          'The server kicked the bot for a wrong password. Re-register the bot with the correct password, then press Start.',
          '#FEE75C'
        );
        return;
      }

      if (parsedReason.includes('throttled') || parsedReason.includes('Exceeded max login')) {
        this.suppressReconnectLog = true;
        this.scheduleReconnect(45000);
      }
    });

    this.bot.on('error', (err) => {
      console.error(`[CypherX AFK] ${this.username}@${this.host}:${this.port} error:`, err.code || err.message);
      this.handleConnectionFailure(err.code || err.message);
    });

    const thisBot = this.bot;
    thisBot.once('end', () => {
      // Ignore 'end' from an old bot instance (after Stop / Restart)
      if (this.bot !== thisBot) return;

      this.isConnected = false;
      this.isConnecting = false;
      this.stopAutoChat();
      this.stopActivity();
      this.clearAuthTimers();
      this.combat.detach();
      this.gatherer.detach(); // the task itself is kept and resumes after reconnect
      this.triggerPanelUpdate();

      if (this.stopped || this.noReconnect) return;
      if (this.reconnectTimer) return; // a reconnect is already queued (e.g. throttle wait)

      // exponential back-off: 20s, 30s, 45s ... capped at 2 minutes
      const delay = Math.min(20000 * Math.pow(1.5, this.reconnectAttempts), 120000);
      this.reconnectAttempts++;
      this.scheduleReconnect(delay);
    });
  }

  /**
   * Drops items from specific slot(s). Supports a single slot (e.g., 36) or comma/space-separated slots (e.g., "36,37,38").
   * @param {string|number} slotsInput - Slot number or list of slots to remove.
   */
  async removeSlots(slotsInput) {
    if (!this.bot || !this.isConnected) return false;

    // Convert input into an array of slot numbers
    const slots = String(slotsInput)
      .split(/[\s,]+/)
      .map(s => parseInt(s.trim(), 10))
      .filter(s => !isNaN(s));

    if (slots.length === 0) return false;

    let removedCount = 0;

    for (const slotId of slots) {
      try {
        const item = this.bot.inventory.slots[slotId];
        if (item) {
          await this.bot.toss(item.type, null, item.count);
          removedCount++;
          this.log(`Slot Remove ${E.DELETE}`, `Dropped item \`${item.name}\` x${item.count} from slot \`${slotId}\`.`, '#FEE75C');
        } else {
          this.log(`Slot Remove ${E.WARN}`, `Slot \`${slotId}\` is empty.`, '#FEE75C');
        }
      } catch (err) {
        this.log(`Slot Remove Error ${E.CROSS}`, `Failed to remove item from slot \`${slotId}\`: ${err.message}`, '#ED4245');
      }
    }

    return removedCount > 0;
  }

  handleConnectionFailure(reason) {
    if (!this.suppressReconnectLog) {
      this.log(
        `Bot Disconnected ${E.CROSS}`,
        `Connection failed on \`${this.host}:${this.port}\` (${reason}).`,
        '#ED4245'
      );
      this.suppressReconnectLog = true;
    }
  }

  scheduleReconnect(delayMs) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.noReconnect) return;
      this.suppressReconnectLog = false;
      this.start();
    }, delayMs);
  }

  stop(keepTask = false) {
    this.stopped = true;
    if (!keepTask) this.gatherer.clearTask();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopAutoChat();
    this.stopActivity();
    this.clearAuthTimers();
    this.combat.detach();
    this.gatherer.detach();

    if (this.bot) {
      this.bot.quit();
      this.bot = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.suppressReconnectLog = false;
    this.triggerPanelUpdate();
  }

  restart() {
    this.stop(true);
    setTimeout(() => {
      this.start();
    }, 3000);
  }

  setAutoMessage(message, intervalMinutes) {
    this.autoChatMessage = message;
    const parsedInterval = parseInt(intervalMinutes, 10);
    this.autoChatIntervalMinutes = isNaN(parsedInterval) || parsedInterval < 1 ? 1 : parsedInterval;

    if (this.autoChatEnabled && this.isConnected) {
      this.startAutoChat();
    }
  }

  toggleAutoChat() {
    this.autoChatEnabled = !this.autoChatEnabled;
    if (this.autoChatEnabled && this.isConnected) {
      this.startAutoChat();
    } else {
      this.stopAutoChat();
    }
    return this.autoChatEnabled;
  }

  // ---------- Anti-AFK activity ----------
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  startActivity() {
    this.stopActivity();
    if (!this.activityEnabled) return;

    const scheduleNext = () => {
      // ~60s with a little random jitter so it looks natural
      const jitter = Math.floor(Math.random() * 10000) - 5000;
      this.activityTimer = setTimeout(async () => {
        await this.performActivity();
        if (this.bot && this.isConnected && this.activityEnabled) scheduleNext();
      }, Math.max(15000, this.activityIntervalMs + jitter));
    };
    scheduleNext();
  }

  stopActivity() {
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
    this.activityRunning = false;
    try {
      if (this.bot && this.bot.clearControlStates) this.bot.clearControlStates();
    } catch (_) {}
  }

  async performActivity() {
    if (!this.bot || !this.isConnected || this.activityRunning) return;
    if (this.combat && this.combat.active) return; // busy fighting
    if (this.gatherer && this.gatherer.busy) return; // busy gathering / crafting
    this.activityRunning = true;

    const alive = () => this.bot && this.isConnected && !(this.combat && this.combat.active) && !(this.gatherer && this.gatherer.busy);
    const hold = async (control, ms) => {
      if (!alive()) return;
      this.bot.setControlState(control, true);
      await this.sleep(ms);
      if (alive()) this.bot.setControlState(control, false);
    };

    try {
      // Look in a random direction
      if (alive()) await this.bot.look(Math.random() * Math.PI * 2, 0, true);

      // Jump (twice)
      await hold('jump', 350);
      await this.sleep(400);
      await hold('jump', 350);
      await this.sleep(500);

      // Walk forward, then back to roughly the same spot
      await hold('forward', 1200);
      await this.sleep(300);
      await hold('back', 1200);
      await this.sleep(300);

      // Strafe a little
      const side = Math.random() < 0.5 ? 'left' : 'right';
      await hold(side, 600);
      await this.sleep(300);
      await hold(side === 'left' ? 'right' : 'left', 600);
      await this.sleep(300);

      // Sneak for a moment
      await hold('sneak', 2000);
    } catch (err) {
      console.error(`[CypherX AFK] ${this.username} activity error:`, err.message);
    } finally {
      try {
        if (this.bot && this.bot.clearControlStates) this.bot.clearControlStates();
      } catch (_) {}
      this.activityRunning = false;
    }
  }

  toggleCombat() {
    return this.combat.setEnabled(!this.combat.enabled);
  }

  toggleActivity() {
    this.activityEnabled = !this.activityEnabled;
    if (this.activityEnabled && this.isConnected) this.startActivity();
    else this.stopActivity();
    return this.activityEnabled;
  }

  startAutoChat() {
    this.stopAutoChat();
    const intervalMs = this.autoChatIntervalMinutes * 60 * 1000;
    this.autoChatInterval = setInterval(() => {
      if (this.bot && this.isConnected) {
        this.bot.chat(this.autoChatMessage);
      }
    }, intervalMs);
  }

  stopAutoChat() {
    if (this.autoChatInterval) {
      clearInterval(this.autoChatInterval);
      this.autoChatInterval = null;
    }
  }
}

module.exports = MinecraftBot;