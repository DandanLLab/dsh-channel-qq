/** OneBot v11 WebSocket transport: forward client and reverse server, echo-based API calls. */
import { EventEmitter } from 'node:events';
import type { ConnectionConfig } from './config.js';
import { type ClientIdentity } from './client-compat.js';
/** Port parsed from a ws://…:port URL (reverse mode binds it; forward mode dials it). */
export declare function urlPort(url: string, fallback: number): number;
export declare class OneBotClient extends EventEmitter {
    readonly connection: ConnectionConfig;
    private readonly accessToken;
    private readonly log;
    private ws;
    private reverseServer;
    private pending;
    private echoSeq;
    private reconnectAttempts;
    private reconnectTimer;
    private heartbeatTimer;
    private lastPongAt;
    private closed;
    selfId: number | null;
    /** 连接的协议端品牌（get_version_info 探测；未完成探测前为 null） */
    clientIdentity: ClientIdentity | null;
    constructor(connection: ConnectionConfig, accessToken: string | undefined, log: (line: string) => void);
    start(): void;
    stop(): void;
    isConnected(): boolean;
    /** One OneBot API call; resolves with `data` on ok, rejects on failure or timeout. */
    call(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    private handleFrame;
    private bindSocket;
    private connectForward;
    private startReverseServer;
    private startHeartbeat;
    private scheduleReconnect;
    private clearPending;
}
