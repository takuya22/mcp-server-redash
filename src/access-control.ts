const ALLOWED_EMAIL = "yana22thx@gmail.com";

export function isAllowedEmail(email: unknown): boolean {
	return typeof email === "string" && email.toLowerCase() === ALLOWED_EMAIL;
}
