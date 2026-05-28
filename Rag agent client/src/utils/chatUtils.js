/**
 * Check if a chat ID is a temporary placeholder (not yet saved to the backend).
 */
export const isTempChat = (id) => id?.toString().startsWith('temp_');
