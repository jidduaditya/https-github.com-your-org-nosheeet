interface Message {
  id: string;
  channel: string;
  direction: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface Props {
  messages: Message[];
}

const CHANNEL_ICONS: Record<string, string> = {
  gmail: '📧',
  whatsapp: '💬',
  calendar: '📅',
  manual: '✏️',
};

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ContactTimeline({ messages }: Props) {
  if (messages.length === 0) {
    return <p className="text-sm text-slate-400 text-center py-8">No messages yet</p>;
  }

  return (
    <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex gap-3 ${msg.direction === 'outbound' ? 'flex-row-reverse' : ''}`}
        >
          <div className="flex-shrink-0 w-7 h-7 bg-slate-100 rounded-full flex items-center justify-center text-sm">
            {CHANNEL_ICONS[msg.channel] ?? '•'}
          </div>
          <div
            className={`max-w-[75%] rounded-xl px-3 py-2 text-sm ${
              msg.direction === 'outbound'
                ? 'bg-brand-600 text-white'
                : 'bg-slate-100 text-slate-800'
            }`}
          >
            <p className="leading-snug">{msg.content}</p>
            <p className={`text-xs mt-1 ${msg.direction === 'outbound' ? 'text-blue-200' : 'text-slate-400'}`}>
              {formatTime(msg.timestamp)}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
