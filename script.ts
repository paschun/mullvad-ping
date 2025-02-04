import { parseArgs } from "https://deno.land/std@0.208.0/cli/parse_args.ts";
import { BaseHandler } from "https://deno.land/std@0.208.0/log/handlers.ts";
import * as log from "https://deno.land/std@0.208.0/log/mod.ts";

type ServerDataJSON = {
  hostname: string;
  country_code: string;
  country_name: string;
  city_code: string;
  city_name: string;
  active: boolean;
  owned: boolean;
  provider: string;
  ipv4_addr_in: string;
  ipv6_addr_in: string;
  network_port_speed: number;
  stboot: boolean;
  type: string;
};

type ServerPingData = {
  hostname: string;
  city: string;
  country: string;
  type: string;
  ip: string;
  avg: number;
  network_port_speed: number;
}

let lastSleep = 0;
function sleep() {
  lastSleep += 10
  const thisSleep = lastSleep
  return new Promise((resolve) => setTimeout(resolve, thisSleep));
}

function checkRunMode(stboot: boolean, runMode: string) {
  if (runMode == "all") {
    return true;
  } else if (runMode == "ram" && stboot == true) {
    return true;
  } else if (runMode == "disk" && stboot == false) {
    return true;
  }
  return false;
}

const serverTypes = ["openvpn", "bridge", "wireguard", "all"];
const runTypes = ["all", "ram", "disk"];

const args = parseArgs(Deno.args);

function setupLogs(): log.Logger {
  function stderrHandler(this: BaseHandler, logRecord: log.LogRecord) {
    if (this.level > logRecord.level) return;

    const msg = this.format(logRecord);

    if (logRecord.level >= log.LogLevels.ERROR) console.error(msg)
    else this.log(msg);
  }

  const pipeFmt = new log.handlers.BaseHandler("INFO", { formatter: "{msg}" })
  pipeFmt.log = console.log
  pipeFmt.handle = stderrHandler

  const debugFmt = new log.handlers.ConsoleHandler("DEBUG")
  debugFmt.handle = stderrHandler


  log.setup({
    handlers: {
      pipeFmt,
      debugFmt,
    },
    loggers: {
      pipe: {
        level: 'INFO',
        handlers: ["pipeFmt"],
      },
      debug: {
        level: 'DEBUG',
        handlers: ["debugFmt"],
      },
    }
  })
  
  const logger = args.debug ? 'debug' : 'pipe'
  return log.getLogger(logger);
}
const logger = setupLogs()

if (args.help || args.h) {
  logger.info(`Usage: script [OPTION]
    --country <code>      the country you want to query (eg. us, gb, de)
    --list-countries      lists the available countries
    --type <type>         the type of server to query (${
    serverTypes.join(", ")
  })
    --count <n>           the number of pings to the server (default 3)`);
  if (Deno.build.os != "windows") {
    logger.info(
      `    --interval <i>        the interval between pings in seconds (default/min 0.2)`,
    );
  }
  logger.info(
    `    --top <n>             the number of top servers to show, (0=all)
    --port-speed <n>      only show servers with at least n Gigabit port speed
    --provider <name>     only show servers from the given provider
    --owned <true|false>  only show servers owned by Mullvad
    --run-mode <type>     only show servers running from (${
      runTypes.join(", ")
    })
    --help                usage information`,
  );
  Deno.exit(0);
}

const country = args.country?.toLowerCase() ?? "ch";
const serverType = args.type?.toLowerCase() ?? "wireguard";
if (!serverTypes.includes(serverType)) {
  throw new Error(`Invalid type, allowed types are: ${serverTypes.join(", ")}`);
}

const interval = parseFloat(args.interval ?? 0.2) || 0.2;
if (interval < 0.2) {
  throw new Error("Minimum interval value is 0.2");
}
const count = parseInt(args.count ?? 3) || 3;
const topN = parseInt(args.top ?? 5) || 5;
const portSpeed = parseInt(args["port-speed"] ?? 0) || 0;

const runMode = args["run-mode"]?.toLowerCase() ?? "all";
if (!runTypes.includes(runMode)) {
  throw new Error(
    `Invalid run-mode, allowed types are: ${runTypes.join(", ")}`,
  );
}

let owned: boolean | null = null;
if (args.owned != null) {
  if (args.owned == "true") {
    owned = true;
  } else if (args.owned == "false") {
    owned = false;
  } else {
    throw new Error("Invalid value for owned, must be true or false");
  }
}

const provider = args.provider;

logger.debug("Fetching currently available relays...");
const response = await fetch(
  `https://api.mullvad.net/www/relays/${serverType}/`,
);
const json: Array<ServerDataJSON> = await response.json();

function parsePing(output: string, server: ServerDataJSON) {
  // [all, min, avg, max, mdev]
  const regex =
    /(?<min>\d+(?:.\d+)?)\/(?<avg>\d+(?:.\d+)?)\/(?<max>\d+(?:.\d+)?)\/(?<mdev>\d+(?:.\d+)?)/;

  const values = output.match(regex);
  if (values) {
    logger.debug(
      `Pinged ${server.hostname}.mullvad.net, min/avg/max/mdev ${values[0]
      }`,
    );

    const result: ServerPingData = {
      hostname: server.hostname,
      city: server.city_name,
      country: server.country_name,
      type: server.type,
      ip: server.ipv4_addr_in,
      avg: parseFloat(values[2]) || 0,
      network_port_speed: server.network_port_speed,
    };
    return result
  }
  logger.error(`no output match for ${server.hostname} - ${output}`)
  return null
}

if (args["list-countries"]) {
  const countries = new Set();
  json.forEach((e) => {
    countries.add(`${e.country_code} - ${e.country_name}`);
  });
  countries.forEach((e) => {
    logger.info(e);
  });
} else {
  const pings = [];

  for (const server of json) {
    if (
      (country == null || country == server.country_code) &&
      (server.network_port_speed >= portSpeed) &&
      checkRunMode(server.stboot, runMode) &&
      (provider == null || provider == server.provider) &&
      (owned == null || owned == server.owned)
    ) {
      const args = [
        "-c",
        count.toString(),
        "-i",
        interval.toString(),
        server.ipv4_addr_in,
      ];

      const p = new Deno.Command(
        "/sbin/ping",
        {
          args,
          stdout: "piped",
        },
      );

      logger.debug(`sending ping to ${server.ipv4_addr_in}`)
      pings.push(sleep().then(_ => p.output()).then((cmdout: Deno.CommandOutput) => {
        const decoder = new TextDecoder()
        const stderr = decoder.decode(cmdout.stderr)
        if (stderr) throw new Error(stderr)
        const stdout = decoder.decode(cmdout.stdout)
        return parsePing(stdout, server)
      }))
    }
  }
  
  const results = (await Promise.all(pings)).filter((r): r is ServerPingData => r !== null)
  logger.debug('got results')

  results.sort((a, b) => {
    return a.avg - b.avg;
  })

  // logger.debug(results)

  const top = topN == 0 ? results : results.slice(0, topN);
  logger.debug('got top '+topN)

  if (top.length > 0) {
    logger.debug('\n\n\n')
    logger.debug(`Top ${top.length} results:`);

    for (const e of top) {
      logger.debug(
        ` - ${e.hostname}.mullvad.net (${
          e.avg.toFixed(1)
        }ms) ${e.network_port_speed} Gigabit ${e.type} ${e.city}, ${e.country}`,
      );
    }
    logger.debug('')
    logger.info(top[0].hostname)
  } else {
    logger.error("No servers found");
  }
}
