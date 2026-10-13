const MinecraftBot = require('./MinecraftBot');
const { E } = require('./emojis');

class BotManager {
  constructor(maxSlots = 70) {
    this.maxSlots = maxSlots;
    this.userSlots = new Map(); // Stores custom slot limits per user ID
    this.bots = new Map();
    this.admins = new Set();
    this.logCallback = null;
    this.updatePanelCallback = null;
  }

  setLogCallback(callback) {
    this.logCallback = callback;
  }

  setUpdatePanelCallback(callback) {
    this.updatePanelCallback = callback;
  }

  triggerPanelUpdate() {
    if (this.updatePanelCallback) {
      this.updatePanelCallback();
    }
  }

  // Custom User Slots Management
  setUserSlots(userId, slots) {
    this.userSlots.set(userId, slots);
  }

  getUserMaxSlots(userId) {
    return this.userSlots.get(userId) || 1; // Default is 1 slot per user
  }

  getUserSlotUsage(userId) {
    let count = 0;
    for (const bot of this.bots.values()) {
      if (bot.ownerId === userId) count++;
    }
    return count;
  }

  // Admin Management
  addAdmin(userId) {
    if (this.admins.has(userId)) return false;
    this.admins.add(userId);
    return true;
  }

  removeAdmin(userId) {
    if (!this.admins.has(userId)) return false;
    this.admins.delete(userId);
    return true;
  }

  isAdmin(userId) {
    return this.admins.has(userId);
  }

  getAdmins() {
    return Array.from(this.admins);
  }

  getActiveCount() {
    let count = 0;
    for (const bot of this.bots.values()) {
      if (bot.isConnected) count++;
    }
    return count;
  }

  getAvailableSlots() {
    return this.maxSlots - this.bots.size;
  }

  registerBot(ownerId, username, serverAddress, password, useAuthPlugin = true, version = '26.1.2') {
    const cleanUsername = username.trim();

    // Minecraft usernames: 3-16 chars, letters / numbers / underscore only (NO spaces)
    if (!/^[A-Za-z0-9_]{3,16}$/.test(cleanUsername)) {
      const suggestion = cleanUsername.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16);
      const hint = suggestion.length >= 3 ? ` Try **${suggestion}** instead.` : '';
      return {
        success: false,
        message: `${E.CROSS} **${cleanUsername}** is not a valid Minecraft username. Use 3-16 characters: letters, numbers or underscore only (no spaces).${hint}`
      };
    }
    const botKey = `${ownerId}_${cleanUsername.toLowerCase()}`;

    if (this.bots.has(botKey)) {
      return { success: false, message: `${E.WARN} A bot named **${cleanUsername}** is already registered.` };
    }

    if (this.bots.size >= this.maxSlots) {
      return { success: false, message: `${E.CROSS} Maximum global bot capacity reached.` };
    }

    const userMax = this.getUserMaxSlots(ownerId);
    const userCurrent = this.getUserSlotUsage(ownerId);
    if (!this.isAdmin(ownerId) && userCurrent >= userMax) {
      return { success: false, message: `${E.CROSS} You have reached your slot limit of **${userMax}** bot(s).` };
    }

    let host = serverAddress.trim();
    let port = 25565;

    if (host.includes(':')) {
      const parts = host.split(':');
      host = parts[0].trim();
      port = parseInt(parts[1], 10) || 25565;
    }

    const botInstance = new MinecraftBot(
      ownerId,
      cleanUsername,
      host,
      port,
      version,
      password,
      useAuthPlugin,
      this.logCallback,
      () => this.triggerPanelUpdate()
    );

    botInstance.botKey = botKey;
    this.bots.set(botKey, botInstance);
    this.triggerPanelUpdate();

    return {
      success: true,
      username: cleanUsername,
      server: `${host}:${port}`,
      botKey,
      message: `${E.CHECK} Bot **${cleanUsername}** registered for \`${host}:${port}\` (Auth Plugin: \`${useAuthPlugin ? 'Yes' : 'No'}\`).`
    };
  }

  startBot(ownerId) {
    const userBots = Array.from(this.bots.values()).filter(bot => bot.ownerId === ownerId);
    if (userBots.length === 0) return { success: false, message: `${E.WARN} No bot registered. Please register first.` };

    let startedCount = 0;
    for (const bot of userBots) {
      if (!bot.isConnected && !bot.isConnecting) {
        if (bot.start()) startedCount++;
      }
    }

    if (startedCount > 0) {
      return { success: true, message: `${E.START} Connecting ${startedCount} bot(s) to Minecraft server...` };
    }
    return { success: false, message: `${E.WARN} Your bot(s) are already running or connecting.` };
  }

  stopBot(ownerId) {
    const userBots = Array.from(this.bots.values()).filter(bot => bot.ownerId === ownerId);
    if (userBots.length === 0) return { success: false, message: `${E.WARN} No registered bot found.` };

    for (const bot of userBots) {
      bot.stop();
    }
    this.triggerPanelUpdate();
    return { success: true, message: `${E.STOP} Bot(s) stopped successfully.` };
  }

  restartBot(ownerId) {
    const userBots = Array.from(this.bots.values()).filter(bot => bot.ownerId === ownerId);
    if (userBots.length === 0) return { success: false, message: `${E.WARN} No registered bot found.` };

    for (const bot of userBots) {
      bot.restart();
    }
    return { success: true, message: `${E.RESTART} Restarting bot(s)...` };
  }

  deleteBot(ownerId) {
    const userBots = Array.from(this.bots.entries()).filter(([_, bot]) => bot.ownerId === ownerId);
    if (userBots.length === 0) return { success: false, message: `${E.WARN} No bot found to delete.` };

    for (const [key, bot] of userBots) {
      bot.stop();
      this.bots.delete(key);
    }
    this.triggerPanelUpdate();
    return { success: true, message: `${E.DELETE} All your bot registrations have been deleted.` };
  }

  // Bulk / Admin Commands
  startAll() {
    let count = 0;
    for (const bot of this.bots.values()) {
      if (!bot.isConnected && !bot.isConnecting) {
        if (bot.start()) count++;
      }
    }
    this.triggerPanelUpdate();
    return count;
  }

  stopAll() {
    let count = 0;
    for (const bot of this.bots.values()) {
      if (bot.isConnected || bot.isConnecting) {
        bot.stop();
        count++;
      }
    }
    this.triggerPanelUpdate();
    return count;
  }

  deleteOffline() {
    let count = 0;
    for (const [key, bot] of this.bots.entries()) {
      if (!bot.isConnected && !bot.isConnecting) {
        bot.stop();
        this.bots.delete(key);
        count++;
      }
    }
    this.triggerPanelUpdate();
    return count;
  }

  getAllBotsStatus() {
    if (this.bots.size === 0) return `${E.INFO} No bots are registered.`;

    let list = [];
    for (const bot of this.bots.values()) {
      let state = `${E.CROSS} Offline`;
      if (bot.isConnected) state = `${E.CHECK} Connected`;
      else if (bot.isConnecting) state = '🟡 Connecting...';

      list.push(`<@${bot.ownerId}> | **${bot.username}** | \`${bot.host}:${bot.port}\` | ${state}`);
    }
    return list.join('\n');
  }

  setAutoMessage(ownerId, message, intervalMinutes) {
    const userBots = Array.from(this.bots.values()).filter(bot => bot.ownerId === ownerId);
    if (userBots.length === 0) return { success: false, message: `${E.WARN} No bot registered. Register a bot first.` };

    for (const bot of userBots) {
      bot.setAutoMessage(message, intervalMinutes);
    }
    return {
      success: true,
      message: `${E.CHECK} Auto-message updated for your bot(s)!\n**Message:** \`${message}\``
    };
  }

  toggleAutoMessage(ownerId) {
    const userBots = Array.from(this.bots.values()).filter(bot => bot.ownerId === ownerId);
    if (userBots.length === 0) return { success: false, message: `${E.WARN} No bot registered.` };

    let state = false;
    for (const bot of userBots) {
      state = bot.toggleAutoChat();
    }
    const statusText = state ? `${E.CHECK} Enabled` : `${E.CROSS} Disabled`;
    return {
      success: true,
      message: `Auto-message is now **${statusText}**.`
    };
  }

  setTask(ownerId, spec) {
    const userBots = Array.from(this.bots.values()).filter(bot => bot.ownerId === ownerId);
    if (userBots.length === 0) return { success: false, message: `${E.WARN} No bot registered. Register a bot first.` };

    let last = null;
    for (const bot of userBots) {
      last = bot.gatherer.setTask(spec);
      if (!last.ok) break;
    }
    return last.ok
      ? { success: true, message: `${E.CHECK} ${last.message}` }
      : { success: false, message: `${E.CROSS} ${last.message}` };
  }

  stopTask(ownerId) {
    const userBots = Array.from(this.bots.values()).filter(bot => bot.ownerId === ownerId);
    if (userBots.length === 0) return { success: false, message: `${E.WARN} No bot registered.` };
    let had = false;
    for (const bot of userBots) {
      if (bot.gatherer.task) had = true;
      bot.gatherer.clearTask();
    }
    return had
      ? { success: true, message: `${E.STOP} Task stopped.` }
      : { success: false, message: `${E.WARN} Your bot has no active task.` };
  }

  toggleChop(ownerId) {
    const userBots = Array.from(this.bots.values()).filter(bot => bot.ownerId === ownerId);
    if (userBots.length === 0) return { success: false, message: `${E.WARN} No bot registered.` };
    const running = userBots.some(b => b.gatherer.task && b.gatherer.task.type === 'wood' && b.gatherer.task.auto);
    return running ? this.stopTask(ownerId) : this.setTask(ownerId, { type: 'wood', count: 0, auto: true });
  }

  toggleCombat(ownerId) {
    const userBots = Array.from(this.bots.values()).filter(bot => bot.ownerId === ownerId);
    if (userBots.length === 0) return { success: false, message: `${E.WARN} No bot registered.` };

    let state = false;
    for (const bot of userBots) {
      state = bot.toggleCombat();
    }
    return {
      success: true,
      message: state
        ? `${E.SWORD} **Grind Mode ON** - your bot will kill hostile mobs (creepers are handled with hit-and-retreat).`
        : `${E.STOP} **Grind Mode OFF** - your bot will only do anti-AFK movement.`
    };
  }

  getStatus(ownerId) {
    const userBots = Array.from(this.bots.values()).filter(bot => bot.ownerId === ownerId);
    if (userBots.length === 0) return { success: false, message: `${E.WARN} No bot registered.` };

    let msgList = userBots.map(bot => {
      let statusStr = `${E.CROSS} Disconnected`;
      if (bot.isConnected) statusStr = `${E.CHECK} Connected`;
      else if (bot.isConnecting) statusStr = '🟡 Connecting...';
      const grind = bot.combat.enabled ? `${E.SWORD} On (${bot.combat.kills} kills)` : 'Off';
      return `${E.STATUS_UP} **Bot:** ${bot.username}\n**Server:** ${bot.host}:${bot.port}\n**Status:** ${statusStr}\n**Grind Mode:** ${grind}\n**Task:** ${bot.gatherer.describe()}`;
    });

    return {
      success: true,
      message: msgList.join('\n---\n')
    };
  }
}

module.exports = BotManager;