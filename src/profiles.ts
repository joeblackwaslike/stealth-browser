/** Saved-login profile a request is routed through. */
export type ProfileName = "ebay" | "reddit" | "anon";

/** Profiles that carry a saved login session. */
export type LoginProfileName = Exclude<ProfileName, "anon">;

/** Routing and pacing rules for one profile. */
export type Profile = {
	name: ProfileName;
	/** Registrable domains; each also matches all of its subdomains. */
	domains: readonly string[];
	minGapMs: readonly [number, number];
	requiresLogin: boolean;
};

/** All profiles, keyed by name. Gaps are jittered between [min, max] ms. */
export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
	ebay: {
		name: "ebay",
		domains: ["ebay.com"],
		minGapMs: [20000, 40000],
		requiresLogin: true,
	},
	reddit: {
		name: "reddit",
		domains: ["reddit.com"],
		minGapMs: [5000, 10000],
		requiresLogin: true,
	},
	anon: {
		name: "anon",
		domains: [],
		minGapMs: [3000, 8000],
		requiresLogin: false,
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
	const host = url.hostname;
	for (const profile of Object.values(PROFILES)) {
		if (profile.domains.some((d) => host === d || host.endsWith(`.${d}`))) {
			return profile.name;
		}
	}
	return "anon";
}
