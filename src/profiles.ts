/** Saved-login profile a request is routed through. */
export type ProfileName = "ebay" | "reddit" | "anon" | "google";

/** Profiles that carry a saved login session. */
export type LoginProfileName = Exclude<ProfileName, "anon" | "google">;

/** Routing and pacing rules for one profile. */
export type Profile = {
	name: ProfileName;
	/** Registrable domains; each also matches all of its subdomains. */
	domains: readonly string[];
	minGapMs: readonly [number, number];
	requiresLogin: boolean;
	/** Whether a blocked verdict pauses this key for the block-pause window. */
	pauseOnBlock: boolean;
};

/** All profiles, keyed by name. Gaps are jittered between [min, max] ms. */
export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
	ebay: {
		name: "ebay",
		domains: ["ebay.com"],
		minGapMs: [20000, 40000],
		requiresLogin: true,
		pauseOnBlock: true,
	},
	reddit: {
		name: "reddit",
		domains: ["reddit.com"],
		minGapMs: [5000, 10000],
		requiresLogin: true,
		pauseOnBlock: true,
	},
	google: {
		name: "google",
		domains: ["google.com"],
		minGapMs: [8000, 15000],
		requiresLogin: false,
		pauseOnBlock: false,
	},
	anon: {
		name: "anon",
		domains: [],
		minGapMs: [3000, 8000],
		requiresLogin: false,
		pauseOnBlock: false,
	},
};

/** Type guard for any profile name. */
export function isProfileName(value: string): value is ProfileName {
	return Object.hasOwn(PROFILES, value);
}

/** Type guard for profiles that carry a saved login. */
export function isLoginProfile(value: string): value is LoginProfileName {
	return isProfileName(value) && PROFILES[value].requiresLogin;
}

/**
 * Pick the profile for a URL: the profile owning its domain or any parent
 * domain (m.ebay.com -> ebay), else `anon`. Matching on label boundaries keeps
 * notebay.com and ebay.com.evil.example out.
 */
export function profileForUrl(url: URL): ProfileName {
	// "ebay.com." is the same host as "ebay.com"; drop the DNS root dot.
	const host = url.hostname.replace(/\.$/, "");
	for (const profile of Object.values(PROFILES)) {
		if (profile.domains.some((d) => host === d || host.endsWith(`.${d}`))) {
			return profile.name;
		}
	}
	return "anon";
}

/**
 * Key pacing and pauses are tracked under: `profile:<name>` for a matched
 * profile, or `host:<hostname>` (lowercased, without its DNS root dot) for
 * `anon`, so a bare host like `ebay` never shares a profile's schedule.
 */
export function scheduleKey(url: URL): string {
	const name = profileForUrl(url);
	return name === "anon"
		? `host:${url.hostname.toLowerCase().replace(/\.$/, "")}`
		: `profile:${name}`;
}
