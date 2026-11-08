import { startVehiclePage } from './vehicles/page.js';
import { message, errorText } from './shared/messages.js';

void startVehiclePage().catch((error) => message(errorText(error)));
