// CypherX AFK - Help Menu (Components V2 container)
// Layout mirrors the reference screenshot:
//   Title + thumbnail  ->  description  ->  prefix / total commands bullets
//   -> quoted module list  ->  "Select Module" dropdown  ->  Support | Invite | Close
//   -> "Powered By" footer
const {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  MessageFlags
} = require('discord.js');
const { E } = require('./emojis');

const BRAND = 'CypherX AFK';
const TAGLINE = 'A Minecraft AFK Bot Manager - Controls Everything';

// Swap any of these for your own custom emoji, e.g. '<:name:123456789012345678>'
const HOME_EMOJI = E.HOME;

// ---------------------------------------------------------------------------
// Module + command registry (single source of truth for the menu AND the count)
// `usage` is shown after the prefix. `admin: true` adds an (Admin) tag.
// ---------------------------------------------------------------------------
const MODULES = [
  {
    key: 'general',
    name: 'General',
    emoji: E.INFO,
    description: 'Everyday commands available to everyone.',
    commands: [
      { usage: 'help', desc: 'Displays this menu.' },
      { usage: 'uptime', desc: 'Shows bot system uptime.' },
      { usage: 'guide', desc: 'Shows the setup guide.' }
    ]
  },
  {
    key: 'afk',
    name: 'AFK Bot',
    emoji: E.BOT,
    description: 'Control your own AFK bot. Use the panel buttons to Register, Start, Stop, Restart, Status, Grind Mode, Auto Chop and Auto Message.',
    commands: [
      { usage: 'chop [count]', desc: 'Chops trees (no count = non-stop, replants saplings).' },
      { usage: 'gather <block> [count]', desc: 'Gathers stone, sand, ores, etc.' },
      { usage: 'craft <item> [count]', desc: 'Crafts planks, sticks, tools, chests...' },
      { usage: 'stoptask', desc: 'Stops the current gather/craft task.' },
      { usage: 'delregbot', desc: 'Deletes your registered bot.' }
    ]
  },
  {
    key: 'slots',
    name: 'Slots',
    emoji: E.STOCK,
    description: 'Check and manage how many bots each user can run.',
    commands: [
      { usage: 'slots [@user]', desc: 'Check available/used bot slots.' },
      { usage: 'addslot <@user> <slots>', desc: 'Grants extra bot slots to a user.', admin: true },
      { usage: 'remove slot <@user> <slots>', desc: 'Removes allowed bot slots from a user.', admin: true }
    ]
  },
  {
    key: 'panel',
    name: 'Panel',
    emoji: E.CLOUDS,
    description: 'Spawn and customize the AFK Bot control panel.',
    commands: [
      { usage: 'panel', desc: 'Spawns the AFK Bot Panel.', admin: true },
      { usage: 'setthumbnail <url>', desc: 'Sets the panel thumbnail (or attach an image).', admin: true },
      { usage: 'setimage <url>', desc: 'Sets the panel banner image (or attach an image).', admin: true },
      { usage: 'removethumbnail', desc: 'Clears the panel thumbnail.', admin: true },
      { usage: 'removeimage', desc: 'Clears the panel banner image.', admin: true },
      { usage: 'setcolor <hex>', desc: 'Sets the panel accent color.', admin: true },
      { usage: 'panelstyle <v2|embed>', desc: 'Container (V2) or classic embed style.', admin: true }
    ]
  },
  {
    key: 'management',
    name: 'Management',
    emoji: E.TOOLS,
    description: 'Bulk actions across every registered bot.',
    commands: [
      { usage: 'startall', desc: 'Starts all offline bots.', admin: true },
      { usage: 'stopall', desc: 'Stops all active bots.', admin: true },
      { usage: 'deloffline', desc: 'Deletes all offline bots.', admin: true },
      { usage: 'allstatus', desc: 'Displays status of all registered bots.', admin: true },
      { usage: 'delregbot <@user>', desc: "Force deletes a user's bot registration.", admin: true }
    ]
  },
  {
    key: 'admin',
    name: 'Bot Admins',
    emoji: '👑',
    description: 'Give or revoke bot admin access.',
    commands: [
      { usage: 'admin add <@user>', desc: 'Grants bot admin access.', admin: true },
      { usage: 'admin remove <@user>', desc: 'Revokes bot admin access.', admin: true },
      { usage: 'admin list', desc: 'Lists current bot admins.', admin: true }
    ]
  },
  {
    key: 'config',
    name: 'Configuration',
    emoji: E.GEAR,
    description: 'Core bot settings.',
    commands: [
      { usage: 'setprefix <prefix>', desc: 'Updates the command prefix.', admin: true },
      { usage: 'setstatus <text>', desc: 'Sets the Discord activity status.', admin: true },
      { usage: 'setlogchannel #channel', desc: 'Configures the log channel.', admin: true },
      { usage: 'guide edit <text>', desc: 'Updates the user guide text.', admin: true }
    ]
  }
];

const TOTAL_COMMANDS = MODULES.reduce((sum, m) => sum + m.commands.length, 0);

// Accepts '<:name:id>' / '<a:name:id>' (custom) or a plain unicode emoji
function toComponentEmoji(str) {
  const m = /^<(a?):(\w+):(\d+)>$/.exec(str || '');
  return m ? { name: m[2], id: m[3], animated: m[1] === 'a' } : str;
}

function inviteUrl(clientId) {
  const perms = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
    PermissionsBitField.Flags.AttachFiles,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.UseExternalEmojis
  ]).bitfield;
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${perms}&scope=bot`;
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(value || '');
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------
function buildSelectRow(ownerId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`help_select:${ownerId}`)
    .setPlaceholder('❯ Select Module From Here')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Home')
        .setValue('home')
        .setDescription('Back to the main menu')
        .setEmoji(toComponentEmoji(HOME_EMOJI)),
      ...MODULES.map(m =>
        new StringSelectMenuOptionBuilder()
          .setLabel(m.name)
          .setValue(m.key)
          .setDescription(`${m.commands.length} command${m.commands.length === 1 ? '' : 's'}`)
          .setEmoji(toComponentEmoji(m.emoji))
      )
    );
  return new ActionRowBuilder().addComponents(menu);
}

function buildButtonRow(ownerId, { clientId, supportUrl }) {
  const row = new ActionRowBuilder();

  // Support only appears when SUPPORT_URL is a valid link (link buttons reject bad URLs)
  if (isHttpUrl(supportUrl)) {
    row.addComponents(
      new ButtonBuilder().setLabel('Support').setStyle(ButtonStyle.Link).setURL(supportUrl)
    );
  }

  row.addComponents(
    new ButtonBuilder().setLabel('Invite').setStyle(ButtonStyle.Link).setURL(inviteUrl(clientId)),
    new ButtonBuilder().setCustomId(`help_close:${ownerId}`).setLabel('Close').setStyle(ButtonStyle.Danger)
  );
  return row;
}

function wrapContainer(header, ownerId, ctx, thumbUrl) {
  const container = new ContainerBuilder();

  const headerText = new TextDisplayBuilder().setContent(header);
  if (thumbUrl) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(headerText)
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbUrl))
    );
  } else {
    container.addTextDisplayComponents(headerText);
  }

  return container;
}

function finish(container, ownerId, ctx) {
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(buildSelectRow(ownerId));
  container.addActionRowComponents(buildButtonRow(ownerId, ctx));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`Powered By ${BRAND}`));

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// ---------------------------------------------------------------------------
// Home view  (matches the screenshot)
// ---------------------------------------------------------------------------
/**
 * @param {object} ctx { prefix, clientId, thumbnailUrl, supportUrl }
 * @param {string} ownerId  user allowed to use the menu
 */
function buildHelpHome(ctx, ownerId) {
  const moduleList = MODULES.map(m => `> ${m.emoji} » ${m.name}`).join('\n');

  const header =
    `# Hey, I'm ${BRAND}™\n` +
    `${TAGLINE}\n\n` +
    `- **My Prefix is** \`${ctx.prefix}\`\n` +
    `- **Total Commands:** \`${TOTAL_COMMANDS}\`\n\n` +
    moduleList;

  return finish(wrapContainer(header, ownerId, ctx, ctx.thumbnailUrl), ownerId, ctx);
}

// ---------------------------------------------------------------------------
// Module view (shown after picking something in the dropdown)
// ---------------------------------------------------------------------------
function buildHelpModule(moduleKey, ctx, ownerId) {
  const mod = MODULES.find(m => m.key === moduleKey);
  if (!mod) return buildHelpHome(ctx, ownerId);

  const list = mod.commands
    .map(c => `> \`${ctx.prefix}${c.usage}\`${c.admin ? ` ${E.LOCK}` : ''}\n> » ${c.desc}`)
    .join('\n> \n');

  const header =
    `# ${mod.emoji} ${mod.name}\n` +
    `${mod.description}\n\n` +
    `- **My Prefix is** \`${ctx.prefix}\`\n` +
    `- **Commands:** \`${mod.commands.length}\`  •  ${E.LOCK} = Admin only\n\n` +
    list;

  return finish(wrapContainer(header, ownerId, ctx, ctx.thumbnailUrl), ownerId, ctx);
}

// ---------------------------------------------------------------------------
// User Guide view (same container style as the panel / help menu)
// ---------------------------------------------------------------------------
function buildGuide(guideText, ctx, ownerId) {
  const body = String(guideText || '').slice(0, 3500);
  const quoted = body.split('\n').map(line => `> ${line}`.trimEnd()).join('\n');

  const header =
    `# ${E.INFO} ${BRAND} - User Guide\n` +
    `${quoted}`;

  const container = wrapContainer(header, ownerId, ctx, ctx.thumbnailUrl);
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(buildButtonRow(ownerId, ctx));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`Powered By ${BRAND}`));

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// ---------------------------------------------------------------------------
// Interaction handler. Returns true if the interaction belonged to the help menu.
// ---------------------------------------------------------------------------
async function handleHelpInteraction(interaction, getContext) {
  const isSelect = interaction.isStringSelectMenu() && interaction.customId.startsWith('help_select:');
  const isClose = interaction.isButton() && interaction.customId.startsWith('help_close:');
  if (!isSelect && !isClose) return false;

  const ownerId = interaction.customId.split(':')[1];

  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      content: `${E.CROSS} This menu belongs to <@${ownerId}>. Run the help command yourself to get your own.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }
    });
    return true;
  }

  if (isClose) {
    await interaction.deferUpdate();
    await interaction.message.delete().catch(() => {});
    return true;
  }

  const ctx = getContext();
  const choice = interaction.values[0];
  const payload = choice === 'home' ? buildHelpHome(ctx, ownerId) : buildHelpModule(choice, ctx, ownerId);
  await interaction.update(payload);
  return true;
}

module.exports = {
  buildHelpHome,
  buildHelpModule,
  buildGuide,
  handleHelpInteraction,
  MODULES,
  TOTAL_COMMANDS
};
