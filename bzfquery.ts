/*
 * MIT License
 *
 * Copyright (c) 2020-2021 The Noah
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 */

import jspack from "./jspack.ts";

const PROTOCOL = "0221"; // bzfs protocol version

export type GameStyle = "FFA" | "CTF" | "OFFA" | "Rabbit";
export type TeamName = "Rogue" | "Red" | "Green" | "Blue" | "Purple" | "Observer" | "Rabbit" | "Hunter";

/** Server query data */
export interface IBZFQuery{
  /** Server game style */
  style: GameStyle;
  /** Configuration options */
  options: IGameOptions;
  /** Team info */
  teams: ITeam[];
  /** All players */
  players: IPlayer[];
  /** Maximum allowed player score */
  maxPlayerScore: number;
  /** Maximum allowed team score */
  maxTeamScore: number;
  /** Maximum number of players */
  maxPlayers: number;
  /** Number of shots */
  maxShots: number;
  /** Game time limit in deciseconds */
  timeLimit: number;
  /** Game time passed in deciseconds */
  elapsedTime: number;
  /** Automatically drop bad flags */
  shake: false | {
    /** Number of wins (points) required */
    wins: number;
    /** Time required to pass in deciseconds */
    timeout: number;
  };
}

/** Game configuration options */
export interface IGameOptions{
  [key: string]: boolean;
  /** Flags enabled */
  flags: boolean;
  /** Jumping enabled */
  jumping: boolean;
  /** Inertia enabled */
  inertia: boolean;
  /** Ricochet enabled (shots bounce off walls) */
  ricochet: boolean;
  /** Shaking bad flags enabled */
  shaking: boolean;
  /** Antidote flags enabled */
  antidote: boolean;
  /** Handicap enabled */
  handicap: boolean;
  /** Inability to shoot teammates */
  noTeamKills: boolean;
}

/** Team information */
export interface ITeam{
  /** Which team (color/name) */
  name: TeamName;
  /** Number of players */
  players: number;
  /** Maximum number of players */
  maxPlayers: number;
  /** Number of wins (points) */
  wins?: number;
  /** Number of losses (-points) */
  losses?: number;
}

/** Player information */
export interface IPlayer{
  /** Team the player is currently on */
  team: TeamName;
  /** Number of wins (points/kills) */
  wins: number;
  /** Number of losses (-points/deaths) */
  losses: number;
  /** @property Number of team kills */
  tks: number;
  /** Callsign (in-game name) */
  callsign: string;
  /** Motto (in-game text) */
  motto: string;
}

// must match GameType order at https://github.com/BZFlag-Dev/bzflag/blob/2.4/include/global.h#L89-L95
const gameStyles = ["FFA", "CTF", "OFFA", "Rabbit"];
// must match TeamColor order at https://github.com/BZFlag-Dev/bzflag/blob/2.4/include/global.h#L54-66
const teamNames = ["Rogue", "Red", "Green", "Blue", "Purple", "Observer", "Rabbit", "Hunter"];

// must match GameOptions at https://github.com/BZFlag-Dev/bzflag/blob/2.4/include/global.h#L97-L108
const gameOptions: {[key: string]: number} = {
  flags: 0x0002,
  jumping: 0x0008,
  inertia: 0x0010,
  ricochet: 0x0020,
  shaking: 0x0040,
  antidote: 0x0080,
  handicap: 0x0100,
  noTeamKills: 0x0400
};

// must match https://github.com/BZFlag-Dev/bzflag/blob/2.4/include/Protocol.h
const messages = {
  queryGame: 0x7167,
  queryPlayers: 0x7170,
  teamUpdate: 0x7475,
  addPlayer: 0x6170
};

/**
 * Decodes options from network
 * @param options Options from network
 */
function decodeOptions(options: number): IGameOptions{
  const _gameOptions = {} as IGameOptions;

  for(const option in gameOptions) {
    if(!gameOptions.hasOwnProperty(option)){
      console.error("game options decoding failed! this should not happen");
      return {} as IGameOptions;
    }

    _gameOptions[option] = (options & gameOptions[option]) > 0;
  }

  return _gameOptions;
}

/**
 * Query the given game server
 *
 * @param host Server hostname/ip
 * @param port Server port
 * @returns Data from server, or `undefined` if not found
 *
 *     import bzfquery from "https://deno.land/x/bzfquery/bzfquery.ts";
 *     const query = await bzfquery("bzflag.ns01.biz", 5154);
 *     console.log(JSON.stringify(query));
 */
export async function bzfquery(host: string = "127.0.0.1", port: number = 5154): Promise<IBZFQuery | undefined>{
  let conn: Deno.Conn;
  try{
    conn = await Deno.connect({
      hostname: host,
      port
    });
  }catch(err){
    console.error(`unable to connect to ${host}:${port}:`, err);
    return;
  }

  let buffer = new Uint8Array(1024);

  // send header
  await conn.write(new TextEncoder().encode("BZFLAG\r\n\r\n"));

  await conn.read(buffer);
  const magic = new TextDecoder("utf-8").decode(buffer);

  if(magic.substr(0, 4) !== "BZFS"){
    console.error("not a bzflag server");
    return;
  }else if(magic.substr(4, 4) !== PROTOCOL){
    console.error("incompatible version");
    return;
  }

  /**
   * Get packet from network and perform basic decoding
   * @returns Packet code and data
   */
  async function getPacket(): Promise<{code: string, buffer: Uint8Array}>{
    let buffer = new Uint8Array(4);
    await conn.read(buffer);
    const [size, code] = jspack.Unpack(">H2s", buffer);
    buffer = new Uint8Array(size);
    await conn.read(buffer);

    return {code, buffer};
  }

  /**
   * Get response from the server
   * @param expectedCode The code which is expected to be received
   */
  async function getResponse(expectedCode: number): Promise<Uint8Array>{
    const timeLimit = new Date().getTime() + 5000;
    const codeStr = new TextDecoder("utf-8").decode(new Uint8Array([expectedCode >> 8, expectedCode & 0XFF]));

    while(new Date().getTime() < timeLimit){
      const {code, buffer} = await getPacket();
      if(code === codeStr){
        return buffer;
      }
    }

    return new Uint8Array([]);
  }

  /**
   * Send command packet to the server
   * @param command Command to execute
   */
  async function cmd(command: number): Promise<Uint8Array>{
    const data = jspack.Pack(">2H", [0, command]);
    if(!data){
      return new Uint8Array();
    }

    await conn.write(new Uint8Array(data));
    const buffer = await getResponse(command);
    return buffer;
  }

  buffer = await cmd(messages.queryGame);
  const [
    style,
    options,
    maxPlayers,
    maxShots,
    ,,,,, // unused team sizes
    observerSize,
    rogueMax,
    redMax,
    greenMax,
    blueMax,
    purpleMax,
    observerMax,
    shakeWins,
    shakeTimeout,
    maxPlayerScore,
    maxTeamScore,
    maxTime,
    elapsedTime
  ] = jspack.Unpack(">22H", buffer);

  buffer = await cmd(messages.queryPlayers);
  const [, numPlayers] = jspack.Unpack(">2H", buffer);

  buffer = await getResponse(messages.teamUpdate);
  const numTeams = buffer[0];
  buffer = buffer.slice(1);

  const teamMaxSizes = [rogueMax, redMax, greenMax, blueMax, purpleMax];
  const teams: ITeam[] = [];
  for(let i = 0; i < numTeams; i++){
    const teamInfo = buffer.slice(0, 8);
    buffer = buffer.slice(8);

    const [team, size, wins, losses] = jspack.Unpack(">4H", teamInfo);
    if(teamMaxSizes[team] < 1){
      continue;
    }

    teams.push({name: teamNames[team] as TeamName, players: size, maxPlayers: teamMaxSizes[team], wins, losses});
  }
  teams.push({name: "Observer", players: observerSize, maxPlayers: observerMax});

  const players: IPlayer[] = [];
  for(let i = 0; i < numPlayers; i++){
    buffer = await getResponse(messages.addPlayer);
    const [id, type, team, wins, losses, tks, callsign, motto] = jspack.Unpack(">b5H32s128s", buffer);
    players.push({team: teamNames[team] as TeamName, wins, losses, tks, callsign: callsign.replace(/\x00/g, ""), motto: motto.replace(/\x00/g, "")});
  }

  conn.close();

  const gameStyle = gameStyles[style] as GameStyle;
  const gameOptions = decodeOptions(options);

  const info: IBZFQuery = {
    style: gameStyle,
    options: gameOptions,
    teams,
    players,
    maxPlayerScore: maxPlayerScore,
    maxTeamScore: maxTeamScore,
    maxPlayers: maxPlayers,
    maxShots: maxShots,
    timeLimit: maxTime,
    elapsedTime: elapsedTime,
    shake: false
  };

  if(gameOptions.shaking){
    info.shake = {
      wins: shakeWins,
      timeout: shakeTimeout
    };
  }

  return info;
}

if(import.meta.main){
  const colors: {
    [index: string]: string;
  } = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    underline: "\x1b[4m",
    blink: "\x1b[5m",
    reverse: "\x1b[7m",
    hidden: "\x1b[8m",
    fgBlack: "\x1b[30m",
    fgRed: "\x1b[31m",
    fgGreen: "\x1b[32m",
    fgYellow: "\x1b[33m",
    fgBlue: "\x1b[34m",
    fgMagenta: "\x1b[35m",
    fgCyan: "\x1b[36m",
    fgWhite: "\x1b[37m",
    BgBlack: "\x1b[40m",
    bgRed: "\x1b[41m",
    bgGreen: "\x1b[42m",
    bgYellow: "\x1b[43m",
    bgBlue: "\x1b[44m",
    bgMagenta: "\x1b[45m",
    bgCyan: "\x1b[46m",
    bgWhite: "\x1b[47m"
  };

  // clear color highlighting when `NO_COLOR` is set
  if(Deno.noColor){
    for(const key in colors){
      colors[key] = "";
    }
  }

  function printUsage(){
    console.log("Usage: bzfquery host[:port]");
  }

  /**
   * Generate a string consisting of `count` spaces
   * @param count Number of spaces
   */
  function createSpaces(count: number): string{
    let spaces = "";
    for(let i = 0; i < count; i++){
      spaces += " ";
    }

    return spaces;
  }

  /**
   * Return a string containing the bool in a printable format
   * @param value Boolean value
   */
  function boolToString(value: boolean): string{
    return `${colors.bright}${value ? `${colors.fgGreen}yes` : `${colors.fgRed}no`}${colors.reset}`;
  }

  function scoreColorText(object: ITeam | IPlayer): string{
    return `${colors.bright}${colors.fgWhite}${(object.wins ?? 0) - (object.losses ?? 0)}${colors.reset}`;
  }

  function teamColorText(team: TeamName): string{
    let color = "";

    switch(team){
      case "Rogue":
        color = colors.fgYellow;
        break;
      case "Red":
        color = colors.fgRed;
        break;
      case "Green":
        color = colors.fgGreen;
        break;
      case "Blue":
        color = colors.fgBlue;
        break;
      case "Purple":
        color = colors.fgMagenta;
        break;
      case "Rabbit":
      case "Observer":
        color = colors.fgWhite;
        break;
      default:
        return team;
    }

    return `${colors.bright}${color}${team}${colors.reset}`;
  }

  if(Deno.args.length === 1){
    switch(Deno.args[0]){
      case "help":
      case "-h":
      case "--help":
        printUsage();
        break;
      default: {
        const host = Deno.args[0].split(":")[0];
        const port = parseInt(Deno.args[0].split(":")[1]) || undefined;

        const query = await bzfquery(host, port);
        if(!query){
          console.log("Server did not respond");
          Deno.exit();
        }

        console.log(`${colors.bright}${colors.underline}${colors.fgWhite}Configuration${colors.reset}:`);
        console.log(`Game style:  ${colors.bright}${colors.fgWhite}${query.style}${colors.reset}`);
        console.log(`Flags:       ${boolToString(query.options.flags)}`);
        console.log(`Jumping:     ${boolToString(query.options.jumping)}`);
        console.log(`Ricochet:    ${boolToString(query.options.ricochet)}`);
        console.log(`Team kills:  ${boolToString(!query.options.noTeamKills)}`);

        console.log(`\n${colors.bright}${colors.underline}${colors.fgWhite}Teams${colors.reset}:`);
        for(const team of query.teams.sort((a, b) => !a.wins || !a.losses || a.players === 0 ? 1 : !b.wins || !b.losses || b.players === 0 ? -1 : (b.wins - b.losses) - (a.wins - a.losses))){
          // set team score to 0 if there no players
          if(team.players === 0){
            team.wins = team.losses = 0;
          }

          console.log(` • ${teamColorText(team.name)}${createSpaces(10 - team.name.length)}[${colors.bright}${scoreColorText(team)}${colors.reset}]`)
        }

        // count spaces required for printing players
        let maxPlayerCallsignLength = 0;
        let maxPlayerScoreLength = 0;
        for(const player of query.players){
          if(player.callsign.length > maxPlayerCallsignLength){
            maxPlayerCallsignLength = player.callsign.length;
          }

          const playerScoreLength = `${player.wins - player.losses}`.length;
          if(playerScoreLength > maxPlayerScoreLength){
            maxPlayerScoreLength = playerScoreLength;
          }
        }

        console.log(`\n${colors.bright}${colors.underline}${colors.fgWhite}Players${colors.reset}:`);
        if(query.players.length > 0){
          for(const player of query.players.sort((a, b) => a.team === "Observer" ? 1 : b.team === "Observer" ? -1 : (b.wins - b.losses) - (a.wins - a.losses))){
            console.log(` • ${player.callsign}${createSpaces(maxPlayerCallsignLength + 2 - player.callsign.length)}[${colors.bright}${scoreColorText(player)}${colors.reset}]${createSpaces(maxPlayerScoreLength + 2 - `${player.wins - player.losses}`.length)}(${teamColorText(player.team)})`)
          }
        }else{
          console.log(" No players online");
        }
      } break;
    }
  }else{
    printUsage();
  }
}

export default bzfquery;
