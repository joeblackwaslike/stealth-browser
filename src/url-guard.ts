import { isIP } from "node:net";

const BLOCKED_SUFFIXES = [".svc", ".cluster.local", ".local"];

function isPrivateIpv4(host: string): boolean {
	const [a = 0, b = 0] = host.split(".").map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127)
	);
}

function isPrivateIpv6(host: string): boolean {
	const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (mapped?.[1] && mapped[2]) {
		const hi = Number.parseInt(mapped[1], 16);
		const lo = Number.parseInt(mapped[2], 16);
		return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
	}
	return (
		host === "::" ||
		host === "::1" ||
		/^f[cd]/.test(host) ||
		/^fe[89ab]/.test(host)
	);
}

/**
 * True when the URL is http(s) and its literal host is not loopback, private,
 * link-local, or a cluster/local DNS name.
 */
export function isPublicHttpUrl(url: URL): boolean {
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) return false;
	if (
		BLOCKED_SUFFIXES.some(
			(suffix) => host.endsWith(suffix) || host === suffix.slice(1),
		)
	)
		return false;
	const ipVersion = isIP(host);
	if (ipVersion === 4) return !isPrivateIpv4(host);
	if (ipVersion === 6) return !isPrivateIpv6(host);
	if (!host.includes(".")) return false;
	// ponytail: literal-host check only; DNS names resolving to private IPs pass. Add resolve-then-check if callers ever stop being Joe's own agents.
	return true;
}
