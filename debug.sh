#!/usr/local/bin/bash
set -x
deno run --allow-net --allow-run script.ts --debug $@
