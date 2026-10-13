// CypherX AFK - Custom Emoji Registry
// Single source of truth for every custom emoji used across the bot.
// `E`  -> string form, for message content / embeds:  <:name:id>
// `B`  -> object form, for button .setEmoji():        { name, id }

const RAW = {
  CHECK:     { name: 'tick_yes',   id: '1559514645465800734' },
  CROSS:     { name: 'tick_no',    id: '1559073385659629630' },
  WARN:      { name: 'codex_warn', id: '1559073376889348137' },
  INFO:      { name: 'Informative',id: '1559073370367336510' },
  STATUS_UP: { name: 'statusup',   id: '1559073381289042071' },
  DELETE:    { name: 'delete',     id: '1559073374490337303' },
  START:     { name: 'start',      id: '1559073388222480395' },
  RESTART:   { name: 'restart',    id: '1559073378974040135' },
  STOP:      { name: 'bstop',      id: '1559073372414025808' },
  RED_BELL:  { name: 'red_bell',   id: '1559513031367721092' },
  PICKAXE:   { name: 'pickaxe',    id: '1559512388322197555' },
  SWORD:     { name: 'enchantsword', id: '1559512710893273120' },
  LOCK:      { name: 'lock',       id: '1559512527778619482' },
  BOT:       { name: 'red_bot',    id: '1559513036761333791' },
  STOCK:     { name: 'stock',      id: '1559513039781363752' },
  MESSAGE:   { name: 'message',    id: '1559513033712341162' },
  TOOLS:     { name: 'tools',      id: '1559514632455061534' },
  CAUTION:   { name: 'caution',    id: '1559514648401813614' },
  CLOUDS:    { name: 'clouds',     id: '1559514630123167824' },
  HOME:      { name: 'Home',       id: '1559514636670210140' },
  FIRE:      { name: 'Fire',       id: '1559514642961662039' },
  GEAR:      { name: 'Gear',       id: '1559514634610933770' }
};

const E = {};
const B = {};
for (const [key, { name, id }] of Object.entries(RAW)) {
  E[key] = `<:${name}:${id}>`;
  B[key] = { name, id };
}

module.exports = { E, B };
