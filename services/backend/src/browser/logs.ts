import { startLogPage } from './device-logs/page.js';
import { message, errorText } from './shared/messages.js';

void startLogPage().catch((error) => message(errorText(error)));
