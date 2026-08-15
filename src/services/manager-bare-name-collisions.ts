/**
 * #1616 — REFUSE THE AMBIGUOUS FROM-SOURCE INSTALL INSTEAD OF PICKING A REPOSITORY.
 *
 * #1611 measured the hazard and DISCLOSED it: ComfyUI-Manager v4 resolves a from-source
 * ("nightly") install by the pack's BARE REPO NAME against one channel's list, then clones
 * the URL recorded in THAT entry — the `repository` the caller passed is stored in the task
 * params and never read on that path. So a caller who names one author's repo can get
 * another author's, and the install reports success. Read off Manager 4.2.2's own source:
 *
 *   load_nightly:      res[y.split('/')[-1]] = (x, False)      # key = bare repo name
 *   get_custom_nodes:  NormalizedKeyDict, get() -> key.strip().lower()
 *   install_by_id:     repo_url = the_node['repository']       # the CHANNEL's URL
 *
 * Disclosure was the right call for #1611 (it was scoped to the channel bug) but it leaves
 * the tool picking silently between two candidate repositories — the exact thing the
 * standing rule says to refuse. This module supplies the pre-dispatch refusal.
 *
 * WHAT WAS MEASURED, 2026-08-15, against all six published channel lists. #1616 reported
 * 65 colliding bare names (35 between `default` and `dev`). That count is CASE-SENSITIVE
 * and therefore low: `get_custom_nodes` stores into a `NormalizedKeyDict` whose `get`
 * normalizes `key.strip().lower()`, so `comfyui_tagger` and `ComfyUI_tagger` are one key.
 * Counting the way the lookup counts gives **111** ambiguous names — and surfaces a class
 * #1616 does not mention at all: **28** names are ambiguous WITHIN a single channel. Two
 * entries under one name collapse onto one key — `load_nightly` overwrites on an
 * exact-case duplicate, `NormalizedKeyDict` on a case-variant one — and the survivor is
 * decided by the order of an upstream JSON file. Those need no second channel to hand back
 * the wrong repository: `default` alone lists both `1038lab/ComfyUI-Pollinations` and
 * `ciga2011/ComfyUI-Pollinations`.
 *
 * WHAT THE GUARD CANNOT SEE, stated rather than papered over:
 *
 *  * WHICH MANAGER GENERATION IS ON THE OTHER END. Bare-name resolution is a v4 property.
 *    The 3.x dialects send `files:[url]` and clone the URL as passed, so for them this
 *    refusal is a false positive — and it still fires, because the PANEL chooses the
 *    dialect from what it detected on its own ComfyUI, after the request leaves here.
 *    The orchestrator's dialect cache is keyed to the base URL IT talks to, which need not
 *    be the ComfyUI the panel drives, so consulting it would gate one machine's install on
 *    another machine's Manager. A 3.x caller clears this with the same explicit `channel`
 *    everyone else uses, and the refusal text says so.
 *
 *  * CNR RE-KEYING, WHICH ALSO DEFEATS THE EXEMPTION BELOW — the one limit here that is
 *    a WRONG ALLOW rather than an over-refusal, so it is stated first and plainly.
 *    `get_custom_nodes` does not key a channel entry by its bare name when that entry's
 *    repo is registered in the Comfy Registry; it keys it by the CNR id:
 *
 *      cnr = self.get_cnr_by_repo(v['files'][0])
 *      if cnr: v['id'] = cnr['id']; node_id = v['id']     # <- the CNR ID, not the name
 *      else:   node_id = v['files'][0].split('/')[-1]     # <- the bare name
 *      res[node_id] = v
 *
 *    So when the repo a channel lists under a name is registered under a DIFFERENT id,
 *    that entry is not reachable by the bare name at all: the lookup misses and falls
 *    through to the CNR fallback below. `bareNameAmbiguity` exempts a call when the
 *    channel carries exactly the caller's repo — and for a re-keyed entry that exemption
 *    is unsound. Verified end to end against the live registry, 2026-08-15:
 *
 *      caller: https://github.com/wildminder/ComfyUI-Chatterbox   (`default` carries it,
 *              so this is exempted here and dispatches)
 *      but:    that repo is registered as id "ComfyUI-ChatterboxTTS", so the sent
 *              "ComfyUI-Chatterbox" misses, and cnr_map["comfyui-chatterbox"] is
 *              sm079/comfyui-chatterbox — which is what gets cloned.
 *
 *    An earlier version of this comment claimed that could never happen, and then that it
 *    was unfixable here. Both were wrong: the re-keying is MEASURABLE, and `REKEYED_REPOS`
 *    now records exactly which candidates a bare-name lookup cannot reach, so the
 *    exemption is applied to what the lookup can actually return rather than to what the
 *    list appears to say. `REGISTRY_TARGETS` records what `cnr_map[name]` then clones, so
 *    the refusal names that repository outright instead of guessing.
 *
 *    STILL NOT CLOSED IN GENERAL, and that is #1624: this covers the 111 names measured
 *    here, but the hazard needs no channel collision at all — ANY pack whose entry is
 *    re-keyed and whose bare name matches a different registry id is exposed, and those
 *    are not enumerated here.
 *
 *  * A pip-installed Manager. `get_data_by_mode` reads the cache file for the configured
 *    channel URL, else the snapshot BUNDLED in the package — a stale, default-flavoured
 *    list — so on that host the list consulted is not the one measured here. The bundled
 *    list is default-flavoured, which is the channel this guard is most accurate about.
 *  * Staleness. The table is a snapshot. A collision added after it was measured is simply
 *    not caught (today's behaviour), and an entry that has since been corrected upstream
 *    causes an unnecessary refusal — which the caller clears by naming a channel, since
 *    the refusal only fires on the channel THIS code defaulted to.
 *
 * GATE ROUND 6 — A CHANNEL MISS IS NOT A DEAD END, AND TREATING IT AS ONE WAS A HOLE.
 * This module's first shape returned "no ambiguity" whenever the asked channel carried
 * nothing under the name, on the reasoning that Manager then answers "not found" and no
 * substitution can occur. That reasoning is wrong, and 4.2.2's own source says so —
 * `install_by_id`, on the `nightly` branch, when the channel lookup misses:
 *
 *   cnr_fallback = self.cnr_map.get(node_id)          # NormalizedKeyDict, lowercased
 *   if cnr_fallback is not None and cnr_fallback.get('repository'):
 *       repo_url = cnr_fallback['repository']         # <- CLONES THE REGISTRY'S REPO
 *   else:
 *       return result.fail(f"Node '{node_id}@{version_spec}' not found in ...")
 *
 * So a miss falls back to the COMFY REGISTRY entry whose id is the bare name, and clones
 * whatever repository that id is registered to — the caller's `repository` is not read
 * there either. "Not found" is only what happens when the registry ALSO lacks the id.
 * Measured against this snapshot: 18 of the 111 contested names are absent from `default`,
 * so on the channel this code defaults to they reached that fallback with nothing checked.
 * A miss on a contested name is therefore an ambiguity in its own right — resolved by
 * registry id rather than by the channel — and is refused with that named as the reason.
 */
import {
  AMBIGUOUS_BARE_NAMES,
  AMBIGUOUS_BARE_NAMES_MEASURED,
  MANAGER_CHANNEL_NAMES,
  REGISTRY_TARGETS,
  REKEYED_REPOS,
  type ManagerChannelName,
} from "./manager-bare-name-data.js";

export {
  AMBIGUOUS_BARE_NAMES,
  AMBIGUOUS_BARE_NAMES_MEASURED,
  MANAGER_CHANNEL_NAMES,
  REGISTRY_TARGETS,
  REKEYED_REPOS,
};
export type { ManagerChannelName };

/**
 * The pack name Manager will resolve by — EXACTLY the panel's `gitRepoName`
 * (web/js/lib/manager-install.js), because that is the value the panel puts in `id` and
 * therefore the value `install_by_id` looks up. Deriving it any other way here would check
 * a different string than the one that gets sent.
 */
export function managerBareName(url: string): string {
  const pathPart =
    url.includes(":") && !url.includes("://") ? url.slice(url.lastIndexOf(":") + 1) : url;
  const clean = pathPart.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  return base.replace(/\.git$/i, "");
}

/**
 * `owner/repo` from a git URL, or undefined when the URL does not carry one.
 *
 * The HOST is never the owner. A last-two-path-segments regex reads
 * `https://github.com/ComfyUI-BiRefNet` as `github.com/ComfyUI-BiRefNet`, which then
 * matches no candidate and gets quoted back to the caller as a repository they never
 * named. An owner-less URL has to come back `undefined` so the refusal says "the URL you
 * passed" instead of inventing one.
 */
export function ownerRepoOf(url: string): string | undefined {
  const noGit = url.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  let path: string;
  const scp = /^(?:[^/@]+@)?[^/:]+:(?!\/\/)(.+)$/.exec(noGit); // git@host:owner/repo
  if (scp) {
    path = scp[1];
  } else {
    const proto = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(.*)$/.exec(noGit);
    if (proto) {
      const afterHost = proto[1].replace(/^[^/]*\//, "");
      if (afterHost === proto[1]) return undefined; // host with no path
      path = afterHost;
    } else {
      path = noGit;
    }
  }
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2) return undefined;
  return `${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
}

/**
 * The host a git URL points at, lowercased, or undefined when it names none — a bare
 * `author/repo` shorthand, which the panel expands to github.com.
 */
export function gitHostOf(url: string): string | undefined {
  const trimmed = url.trim();
  const scp = /^(?:[^/@]+@)?([^/:]+):(?!\/\/)/.exec(trimmed);
  if (scp) return scp[1].toLowerCase();
  const proto = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)/.exec(trimmed);
  return proto ? proto[1].toLowerCase() : undefined;
}

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Read a key that the object OWNS, or `undefined`.
 *
 * Both lookups below are indexed by a caller-supplied string — the bare name off their URL
 * and the `channel` they passed — against object literals, which inherit from
 * `Object.prototype`. A plain `obj[key]` therefore ANSWERS for `__proto__`, `constructor`
 * and `toString`: `entry["__proto__"]` hands back `Object.prototype`, whose `.length` is
 * `undefined`, so neither the falsy check nor the `length === 0` check stops it and the
 * inherited object rides all the way into `listRepos`, where `.map` is not a function and
 * the tool throws instead of answering. `channel:"constructor"` is worse — `Object.length`
 * is 1, so it reaches `sameRepo(undefined, …)`. Not a trust boundary (this is one machine),
 * just a name nobody's table contains being treated as a hit. An own-property check is the
 * whole fix, and it keeps the promise the unknown-channel path already makes: a channel
 * this table has never heard of is NOT checked, rather than throwing.
 */
function ownCandidates<T>(obj: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * Is this URL comparable to a snapshot candidate at all? The snapshot holds github.com
 * repositories only — `load_nightly` reaches an entry through a `github.com` file — so an
 * `owner/repo` that came off ANOTHER host is a different repository that merely shares a
 * path. `https://gitlab.com/0dot77/comfyui-annotations` must not read as a match for
 * `github.com/0dot77/comfyui-annotations`: v4 would still resolve the bare name against
 * the channel and clone the GitHub one, which is the substitution this guard exists for.
 */
function comparableToSnapshot(url: string): boolean {
  const host = gitHostOf(url);
  return host === undefined || host === "github.com" || host === "www.github.com";
}

export interface BareNameAmbiguity {
  /** The name as it will be SENT (case preserved), e.g. "ComfyUI-BiRefNet". */
  bare: string;
  /** The URL the caller passed, verbatim — what to quote when no owner can be trusted. */
  callerUrl: string;
  /**
   * `owner/repo` the caller named, set ONLY when it is comparable to the snapshot: their
   * URL parsed AND pointed at github.com. Off-host and owner-less URLs leave it undefined
   * rather than quoting back a repository the caller never named.
   */
  callerRepo?: string;
  /** The channel about to be asked. */
  channel: string;
  /**
   * What a BARE-NAME lookup can actually get back from that channel's list — >1 means it
   * is ambiguous alone. EMPTY means nothing under that name is reachable, which is not a
   * dead end: see `resolvedVia`. Entries the channel lists but Manager re-keys to a CNR id
   * are NOT here (they are in `unreachableCandidates`), because the lookup cannot return
   * them and a message naming them would describe an install that cannot happen.
   */
  channelCandidates: readonly string[];
  /**
   * Repos the channel does list under the name but which a bare-name lookup cannot reach,
   * because Manager keyed them by their Comfy Registry id instead. These are why an
   * apparently exact match is not proof of anything.
   */
  unreachableCandidates: readonly string[];
  /**
   * What `cnr_map[<bare name>]` resolves to — the repository actually cloned when the
   * channel lookup misses. Undefined when the registry holds no pack of that name, in
   * which case Manager answers "not found" instead.
   */
  registryTarget?: string;
  /** Channels whose list resolves the name to exactly the caller's repo, if any. */
  channelsResolvingToCaller: readonly string[];
  /**
   * WHAT WILL ACTUALLY DECIDE THE CLONE (gate round 6).
   *  * `"channel"` — the asked channel carries the name, so `channelCandidates` is what
   *    v4 may clone.
   *  * `"cnr-fallback"` — it carries nothing under it, so v4's `nightly` path falls back
   *    to `cnr_map[bare]` and clones the repository registered under that COMFY REGISTRY
   *    id. Nothing here can see which repo that is, so every candidate is named instead.
   */
  resolvedVia: "channel" | "cnr-fallback";
  /** Every repository the snapshot has seen under the name, across all six channels. */
  allCandidates: readonly string[];
}

/** The channels `normalize_channel` accepts — anything else never reaches a list. */
const KNOWN_CHANNELS: ReadonlySet<string> = new Set(MANAGER_CHANNEL_NAMES);

/**
 * Would asking `channel` for this URL's bare name resolve to a repository other than the
 * one the caller named? Returns the candidates when so, `undefined` when the name is not
 * known to collide, when the channel is not one Manager accepts, or when the channel lists
 * exactly the caller's repo and nothing else under it.
 *
 * A channel that does NOT list the name is an ambiguity rather than an exemption — v4's
 * `nightly` path falls back to the Comfy Registry id (gate round 6, quoted in the header),
 * so the caller's `repository` goes unread there just the same.
 *
 * Absence FROM THE SNAPSHOT is NOT proof of uniqueness — an unlisted name is one this
 * snapshot has not seen collide, which is precisely today's behaviour for it.
 */
export function bareNameAmbiguity(url: string, channel: string): BareNameAmbiguity | undefined {
  const bare = managerBareName(url);
  const entry = ownCandidates(AMBIGUOUS_BARE_NAMES, bare.trim().toLowerCase());
  if (!entry) return undefined;
  const asked = channel.trim().toLowerCase();
  // A channel name Manager does not accept is not reasoned about at all: `normalize_channel`
  // raises InvalidChannel and no list is ever consulted, so there is no substitution to
  // warn about and no CNR fallback to reach. This is also what keeps an INHERITED key
  // (`__proto__`, `constructor`) from being read as a miss and refused on that basis.
  if (!KNOWN_CHANNELS.has(asked)) return undefined;
  const nameKey = bare.trim().toLowerCase();
  // GATE ROUND 8 — WHAT THE CHANNEL LISTS IS NOT WHAT THE LOOKUP CAN REACH. A repo that
  // is registered in the Comfy Registry under some other id is keyed by that id, so the
  // bare name cannot return it however plainly the list "carries" it.
  const rekeyed = REKEYED_REPOS[nameKey] ?? [];
  const reachableIn = (cands: readonly string[] | undefined): readonly string[] =>
    (cands ?? []).filter((r) => !rekeyed.some((k) => k === r));
  const listed = ownCandidates(entry, asked as ManagerChannelName) ?? [];
  const channelCandidates = reachableIn(listed);
  const unreachableCandidates = listed.filter((r) => !channelCandidates.includes(r));
  const callerRepo = comparableToSnapshot(url) ? ownerRepoOf(url) : undefined;
  if (channelCandidates.length === 1 && callerRepo && sameRepo(channelCandidates[0], callerRepo)) {
    // EXEMPT, and now soundly: the one entry the lookup can reach under this name IS the
    // caller's repo, so there is nothing to pick between and nothing to fall back to.
    return undefined;
  }
  const channelsResolvingToCaller = callerRepo
    ? MANAGER_CHANNEL_NAMES.filter((c) => {
        const cands = reachableIn(ownCandidates(entry, c));
        return cands.length === 1 && sameRepo(cands[0], callerRepo);
      })
    : [];
  const registryTarget = REGISTRY_TARGETS[nameKey];
  const allCandidates = [
    ...new Set([
      ...MANAGER_CHANNEL_NAMES.flatMap((c) => reachableIn(ownCandidates(entry, c))),
      ...(registryTarget ? [registryTarget] : []),
    ]),
  ];
  return {
    bare,
    callerUrl: url.trim(),
    callerRepo,
    channel,
    channelCandidates,
    unreachableCandidates,
    registryTarget,
    channelsResolvingToCaller,
    resolvedVia: channelCandidates.length === 0 ? "cnr-fallback" : "channel",
    allCandidates,
  };
}

/**
 * GATE ROUND 4 — THE CHANNEL EXEMPTION IS INVALID WHEN NO CHANNEL IS CONSULTED.
 *
 * `bareNameAmbiguity` above waves a call through when the asked-for channel carries
 * exactly the caller's repository and nothing else: there is nothing to pick between, so
 * nothing to refuse. That reasoning holds only on the from-source path. Manager gates the
 * whole channel lookup on the version:
 *
 *   install_by_id(node_id, version_spec, channel, mode)
 *     if version_spec == 'unknown' or version_spec == 'nightly':
 *         custom_nodes = await self.get_custom_nodes(channel, mode)   # <- channel read HERE
 *         ...
 *     ...
 *     res = self.cnr_install(node_id, version_spec, ...)              # <- and NOT here
 *
 * So an explicit CNR version skips the channel entirely and installs the Comfy Registry
 * pack whose **id is the bare name** — the `repository` the caller passed is not read on
 * that path either. Measured: `{repository:"https://github.com/hieuck/ComfyUI-BiRefNet",
 * version:"1.0.0"}` was allowed through because `default` carries hieuck's repo, but
 * registry id `comfyui-birefnet` is `viperyl/ComfyUI-BiRefNet` (api.comfy.org, publisher
 * "Zephrus shawn"). The caller named hieuck and would have got viperyl, reported as a
 * success — the exact substitution this guard exists to refuse, waved through by the
 * guard's own exemption.
 *
 * Scoped to the names this snapshot measured as contested. A git URL whose name is NOT
 * known to collide keeps today's behaviour on this path: its `repository` is ignored just
 * the same, but that is the standing CNR-route property #1616 did not open and this PR
 * does not close — the dispatch note already discloses it.
 */
export interface RegistryVersionAmbiguity {
  /** The bare name, which on this path IS the registry id looked up. */
  bare: string;
  /** The URL the caller passed, verbatim. */
  callerUrl: string;
  /** `owner/repo` the caller named, when comparable to the snapshot. */
  callerRepo?: string;
  /** The non-nightly version that routes this to the registry instead of a channel. */
  version: string;
  /** Every repository the snapshot has seen under this name, across all channels. */
  candidates: readonly string[];
}

/**
 * Is this a registry-version install of a name measured to be contested? `version` is the
 * value that will actually be sent. `nightly` and `unknown` are the from-source specs that
 * DO consult the channel — those belong to `bareNameAmbiguity`, not here.
 */
export function registryVersionAmbiguity(
  url: string,
  version: string,
): RegistryVersionAmbiguity | undefined {
  const spec = version.trim().toLowerCase();
  if (spec === "nightly" || spec === "unknown" || spec.length === 0) return undefined;
  const bare = managerBareName(url);
  const entry = ownCandidates(AMBIGUOUS_BARE_NAMES, bare.trim().toLowerCase());
  if (!entry) return undefined;
  const candidates = [
    ...new Set(MANAGER_CHANNEL_NAMES.flatMap((c) => ownCandidates(entry, c) ?? [])),
  ];
  if (candidates.length === 0) return undefined;
  return {
    bare,
    callerUrl: url.trim(),
    callerRepo: comparableToSnapshot(url) ? ownerRepoOf(url) : undefined,
    version: version.trim(),
    candidates,
  };
}

/**
 * The refusal for that case. The remedy is not a channel — a channel changes nothing on
 * this route — it is DROPPING the version, which puts the call back on the from-source
 * path where the channel does decide and where this guard can actually reason about it.
 */
export function registryVersionRefusal(a: RegistryVersionAmbiguity): string {
  const asked = a.callerRepo ? `https://github.com/${a.callerRepo}` : `"${a.callerUrl}"`;
  return (
    `REFUSED before dispatch — the version you passed takes this install off the ` +
    `from-source path entirely, and on the path it lands on your \`repository\` is not ` +
    `read at all. ComfyUI-Manager only consults a channel's list for version "nightly" ` +
    `or "unknown"; with an explicit version ("${a.version}") it installs the Comfy ` +
    `Registry pack whose ID is the bare repo name — here "${a.bare}" — and that registry ` +
    `entry belongs to whoever published the id, not to you. You asked for ${asked}, and ` +
    `"${a.bare}" is one of the names measured to be claimed by more than one repository ` +
    `(${listRepos(a.candidates)}), so the id may well not resolve to yours. ` +
    `Not picked for you: drop \`version\` (or pass "nightly") and this becomes the ` +
    `from-source install that DOES honour the channel's entry for that name — which is ` +
    `the only route where naming a repository means anything. If you specifically want ` +
    `the registry pack, pass its id as \`id\` instead of a URL, so what you are asking ` +
    `for is the thing that gets installed. Naming a \`channel\` does NOT clear this one — ` +
    `Manager never reads a channel on this route, so there is no channel argument that ` +
    `could make it fetch what you named. (Snapshot measured ` +
    `${AMBIGUOUS_BARE_NAMES_MEASURED}.)`
  );
}

/** "X, Y and Z" — the candidates are NAMED, never reduced to a count. */
function listRepos(repos: readonly string[]): string {
  const urls = repos.map((r) => `https://github.com/${r}`);
  if (urls.length === 1) return urls[0];
  return `${urls.slice(0, -1).join(", ")} and ${urls[urls.length - 1]}`;
}

/**
 * The pre-dispatch refusal. Names BOTH sides — what the caller asked for and what the
 * channel would actually clone — and gives the one argument that proceeds, because a
 * refusal a caller cannot get past is a worse tool than the hazard it prevents.
 */
export function ambiguousBareNameRefusal(a: BareNameAmbiguity): string {
  // Quote the URL verbatim when `callerRepo` is unset — an off-host or owner-less URL has
  // no github owner to name, and inventing one would report a repository they never typed.
  const asked = a.callerRepo ? `https://github.com/${a.callerRepo}` : `"${a.callerUrl}"`;
  // When the channel DOES list the caller's repo but Manager cannot reach it by name, say
  // so explicitly — otherwise "the channel does not carry that name" reads as flatly wrong
  // to anyone who just looked the pack up in that list.
  const shadowed = a.unreachableCandidates.length
    ? ` (it does list ${listRepos(a.unreachableCandidates)}, but that entry is registered ` +
      `in the Comfy Registry under a different id, so Manager keyed it by THAT id and a ` +
      `lookup for "${a.bare}" cannot return it)`
    : "";
  const within =
    a.resolvedVia === "cnr-fallback"
      ? `no entry reachable by that name exists in the "${a.channel}" channel's list` +
        `${shadowed} — which is NOT the end of it: on a "nightly" spec v4 then falls back ` +
        `to the Comfy Registry map (install_by_id → cnr_map) and clones ` +
        (a.registryTarget
          ? `what the id "${a.bare}" is registered to, which is ` +
            `https://github.com/${a.registryTarget}`
          : `whatever repository is registered under the id "${a.bare}"`)
      : a.channelCandidates.length > 1
        ? `the "${a.channel}" channel's list carries that name TWICE — under ${listRepos(a.channelCandidates)} — and which one v4 returns depends on the order of that list`
        : `the "${a.channel}" channel's list carries that name under ${listRepos(a.channelCandidates)}`;
  const escape = a.channelsResolvingToCaller.length
    ? `The repository you named is what ${a.channelsResolvingToCaller
        .map((c) => `channel:"${c}"`)
        .join(" or ")} resolves "${a.bare}" to — pass that and this proceeds.`
    : `No channel in the snapshot resolves "${a.bare}" to the repository you named, so a ` +
      `Manager install cannot be made to fetch it: use install_custom_node (source:"git"), ` +
      `which clones the URL directly instead of resolving a name.`;
  // GATE ROUND 2 — THE BYPASS SENTENCE USED TO CONTRADICT THE REMEDY ABOVE IT. It read
  // "naming any `channel` explicitly makes the choice yours and bypasses it" for EVERY
  // refusal, including the ones whose `escape` had just said no channel resolves this name
  // to the caller's repository at all. A caller who followed the last thing they read
  // passed `channel:"default"`, dispatched, and got the other author's code reported as a
  // success — the exact install this guard exists to stop, reached through the guard's own
  // advice. Measured: for all 65 repositories that sit inside a multi-candidate channel,
  // NO channel resolves them uniquely, so that sentence was wrong for every one of them.
  //
  // The bypass still has to exist — those 65 have no other `channel` to be sent to, and on
  // Manager 3.x the install is correct — so it is kept and re-described rather than
  // removed: it dispatches, it cannot aim, and 3.x is the one reason to take it.
  const bypass = a.channelsResolvingToCaller.length
    ? `naming any \`channel\` explicitly makes the choice yours and bypasses it. Bypass it ` +
      `that way also if this ComfyUI runs Manager 3.x, where the from-source request ` +
      `carries the URL in \`files\` and IS cloned as passed`
    : `naming a \`channel\` explicitly does still bypass this check — but do not read that ` +
      `as the remedy here, because no channel resolves "${a.bare}" to the repository you ` +
      `named. The bypass would dispatch an install you have no way to aim, and on v4 it ` +
      `lands on whichever entry that channel's list order happens to keep. The one reason ` +
      `to take it is a ComfyUI running Manager 3.x, where the from-source request carries ` +
      `the URL in \`files\` and IS cloned as passed`;
  // The opener must not assert the mechanism the NEXT clause rules out: on a miss there is
  // no channel entry and nothing is cloned "from there".
  const opener =
    a.resolvedVia === "cnr-fallback"
      ? `ComfyUI-Manager v4 resolves a from-source install by the BARE REPO NAME ` +
        `("${a.bare}"), ignoring the \`repository\` field entirely.`
      : `ComfyUI-Manager v4 resolves a from-source install by the BARE REPO NAME ` +
        `("${a.bare}") against ONE channel's list and clones the URL recorded there, ` +
        `ignoring the \`repository\` field entirely.`;
  return (
    `REFUSED before dispatch — this install would not necessarily have installed the ` +
    `repository you named. ${opener} You asked for ${asked}, and ${within}. ` +
    `So this would have cloned someone else's code and reported success. Not picked for ` +
    `you: ${escape} ` +
    `(This check ran because no \`channel\` was named, against a snapshot of the six ` +
    `published channel lists measured ${AMBIGUOUS_BARE_NAMES_MEASURED}; ${bypass} — this ` +
    `check cannot tell the generations apart, because the panel picks the dialect after ` +
    `the request leaves here.)`
  );
}

/**
 * The same collision, for a caller who DID name the channel. They made that choice, so
 * this dispatches — but it names the concrete repository their channel carries instead of
 * the generic "111 bare names collide" warning that would otherwise ride along.
 *
 * GATE ROUND 2 — "BECAUSE YOU CHOSE THE CHANNEL" IS FALSE FOR AN INTRA-CHANNEL COLLISION.
 * When the named channel carries the name once, the caller really did choose between the
 * channels and this dispatches on their choice. When it carries the name TWICE, both
 * entries live in the list they named: their channel argument selected nothing, no other
 * channel argument could, and v4 falls back on upstream list order. Telling that caller
 * their choice was honoured invites them to trust an install they never actually aimed —
 * so it says instead that nothing here disambiguated, and names the route that clones the
 * URL verbatim.
 */
export function ambiguousBareNameWarning(a: BareNameAmbiguity): string {
  // Quote the URL verbatim when `callerRepo` is unset — an off-host or owner-less URL has
  // no github owner to name, and inventing one would report a repository they never typed.
  const asked = a.callerRepo ? `https://github.com/${a.callerRepo}` : `"${a.callerUrl}"`;
  const ambiguousAlone = a.channelCandidates.length > 1;
  const carries =
    a.resolvedVia === "cnr-fallback"
      ? `has nothing reachable under "${a.bare}"` +
        (a.unreachableCandidates.length
          ? ` (it lists ${listRepos(a.unreachableCandidates)}, but that entry is keyed by ` +
            `its Comfy Registry id, not by the repo name)`
          : "") +
        ` — so v4 falls back to the registry id of that name and clones ` +
        (a.registryTarget
          ? `https://github.com/${a.registryTarget}`
          : `whatever repository it is registered to`)
      : ambiguousAlone
        ? `carries "${a.bare}" TWICE — under ${listRepos(a.channelCandidates)} — and v4 keeps whichever comes last in that list`
        : `resolves "${a.bare}" to ${listRepos(a.channelCandidates)}`;
  const why =
    a.resolvedVia === "cnr-fallback"
      ? `Naming that channel did NOT aim this one either — it lists nothing under that ` +
        `name, so v4 never reads your channel at all and resolves the registry id ` +
        `instead; any other channel that also misses lands in exactly the same place. ` +
        `Dispatched because you named a channel, and because on Manager 3.x the URL you ` +
        `passed IS what gets cloned; if this is v4 and you need the repository you typed, ` +
        `install_custom_node (source:"git") clones it directly instead of resolving a name`
      : ambiguousAlone
        ? `Naming that channel did NOT disambiguate this one — both entries are in the list ` +
          `you named, so no \`channel\` argument can separate them and on v4 the winner is ` +
          `that list's order. Dispatched because you named a channel, and because on Manager ` +
          `3.x the URL you passed IS what gets cloned; if this is v4 and you need the ` +
          `repository you typed, install_custom_node (source:"git") clones it directly ` +
          `instead of resolving a name`
        : `Dispatched anyway because you chose the channel`;
  const resolves =
    a.resolvedVia === "cnr-fallback"
      ? `v4 resolves this install by the bare name, and with no channel entry to use it ` +
        `takes the registry's repository for that id`
      : `v4 resolves this install by the bare name and clones the URL from ITS list`;
  return (
    `NAMED-CHANNEL COLLISION: you asked for ${asked}, but the "${a.channel}" channel you ` +
    `named ${carries}. ${resolves}, so what lands is very likely not what you passed. ` +
    `${why} — verify with panel_list_nodes before you restart or report success. ` +
    `(Snapshot measured ${AMBIGUOUS_BARE_NAMES_MEASURED}.)`
  );
}
