const FORBIDDEN_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
const WHITESPACE = /\s+/g;
const MAX_BASE_NAME_LENGTH = 80;

export function normalizeMeetingType(rawMeetingType: string) {
    const normalized = rawMeetingType.trim().toLowerCase();

    if (normalized === 'seminar') {
        return 'SEMINAR' as const;
    }

    if (normalized === 'rapat') {
        return 'RAPAT' as const;
    }

    throw new Error('meetingType must be either seminar or rapat');
}

export function sanitizeFilenameBaseName(input: string) {
    const cleaned = input
        .normalize('NFKC')
        .replace(FORBIDDEN_FILENAME_CHARS, ' ')
        .replace(WHITESPACE, ' ')
        .trim();

    const collapsed = cleaned.replace(/ /g, '_');
    const fallback = collapsed || 'meeting';
    return fallback.slice(0, MAX_BASE_NAME_LENGTH);
}
