import Console from './console';
import { requireChatGPTUser } from './chatgpt-auth';
export const dynamic = 'force-dynamic';
export default async function Page() { const user=await requireChatGPTUser('/'); return <Console name={user.displayName}/>; }
