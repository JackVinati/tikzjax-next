import { apiVersion, Platform } from 'obsidian';

/**
 * The device, as a bug report from the diagnostics view needs it (ui/report.ts). Every field is
 * what Obsidian or the WebView says of itself; nothing here names the user, the vault or a note.
 *
 * Not `navigator.userAgent`. The community store's rules forbid reading it, and forbid waiving that
 * rule even for a string that is only copied, because it is how plugins guess the operating system.
 * The OS family comes from Platform instead, and what that string would have told about the
 * WebView is asked of it directly: the features the engine's start can use where
 * they exist, and how many cores and how much memory the device reports.
 */
export interface Device {
	/** Obsidian's `apiVersion`, the version of the app's API: the app's own version in practice. */
	obsidian: string;
	platform: 'desktop' | 'phone' | 'tablet';
	os: 'iOS' | 'Android' | 'macOS' | 'Windows' | 'Linux' | 'unknown';
	webView: WebViewFeatures;
}

/** What the WebView has, by feature check rather than by name. */
export interface WebViewFeatures {
	/** `DecompressionStream`: native gzip. Safari 16.4 and Chrome 80 on. */
	decompressionStream: boolean;
	/** `Uint8Array.fromBase64`: native base64. */
	fromBase64: boolean;
	/** `navigator.hardwareConcurrency`, or null where it is not given. */
	cores: number | null;
	/** `navigator.deviceMemory`, in GiB as the browser rounds it; null where it is not given, as in WebKit. */
	memoryGiB: number | null;
}

export function device(): Device {
	return {
		obsidian: apiVersion,
		platform: Platform.isMobile ? (Platform.isTablet ? 'tablet' : 'phone') : 'desktop',
		os: osFamily(),
		webView: webViewFeatures(),
	};
}

/**
 * The operating system's family. iOS and iPadOS first: Obsidian reports them as macOS too, since
 * they pretend to be one.
 */
function osFamily(): Device['os'] {
	if (Platform.isIosApp) return 'iOS';
	if (Platform.isAndroidApp) return 'Android';
	if (Platform.isMacOS) return 'macOS';
	if (Platform.isWin) return 'Windows';
	if (Platform.isLinux) return 'Linux';
	return 'unknown';
}

export function webViewFeatures(): WebViewFeatures {
	const nav = (typeof navigator === 'undefined' ? {} : navigator) as {
		hardwareConcurrency?: number;
		deviceMemory?: number;
	};
	return {
		decompressionStream:
			typeof (window as { DecompressionStream?: unknown }).DecompressionStream === 'function',
		fromBase64: typeof (Uint8Array as { fromBase64?: unknown }).fromBase64 === 'function',
		cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
		memoryGiB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
	};
}
