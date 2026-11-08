import { loadDetail } from './api.js';
import { query } from '../shared/dom.js';
import { message, errorText } from '../shared/messages.js';

export async function showLogDetail(id: string) {
  try {
    const data = await loadDetail(id);

    query('#detail-content').textContent = JSON.stringify(data, null, 2);
    query<HTMLDialogElement>('#log-detail').showModal();
  } catch (e) {
    message(errorText(e));
  }
}
