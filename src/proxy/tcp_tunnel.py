"""
TCP tunnel handler - Wraps TCP data for relay through HTTP/WebSocket.

Accepts raw TCP connections (SSH, DNS, SMTP, etc.) and tunnels them through:
1. Google Apps Script (for quota-sensitive use)
2. Cloudflare Worker with WebSocket (for better performance)
3. Direct VPS exit node (for maximum performance)

Flow:
  Client TCP → Local Proxy → Domain Fronter → Google/Cloudflare → Target Server
"""

import asyncio
import logging
import uuid
import json
import base64
import time
import socket
from typing import Dict, Optional, Tuple, Callable
from dataclasses import dataclass, field
from collections import deque
from enum import Enum

log = logging.getLogger("TCPTunnel")

POLL_INTERVAL = 0.05  # seconds (20x per second = low latency)
TUNNEL_IDLE_TIMEOUT = 600  # 10 minutes without activity
MAX_CHUNK_SIZE = 65536  # 64KB per request
PING_INTERVAL = 30  # Keep-alive ping every 30 seconds


class TunnelMode(Enum):
    """Exit node mode (affects routing & performance)."""
    GOOGLE_APPS_SCRIPT = "apps_script"  # HTTP polling
    CLOUDFLARE_WEBSOCKET = "cloudflare"  # WebSocket (better)
    VPS_DIRECT = "vps"  # Direct TCP relay


@dataclass
class TunnelState:
    """Manages state for a single TCP tunnel."""
    tunnel_id: str
    target_host: str
    target_port: int
    created_at: float
    last_activity: float
    last_ping: float
    mode: TunnelMode
    seq_send: int = 0  # Sequence number for sends
    seq_recv: int = 0  # Sequence number for receives
    send_buffer: deque = field(default_factory=deque)  # bytes to send to server
    recv_buffer: deque = field(default_factory=deque)  # bytes received from server
    closed: bool = False
    
    def is_expired(self, now: float) -> bool:
        """Check if tunnel exceeded idle timeout."""
        return (now - self.last_activity) > TUNNEL_IDLE_TIMEOUT
    
    def needs_ping(self, now: float) -> bool:
        """Check if tunnel needs keep-alive ping."""
        return (now - self.last_ping) > PING_INTERVAL
    
    def update_activity(self):
        """Update last activity timestamp."""
        self.last_activity = time.time()
    
    def update_ping(self):
        """Update last ping timestamp."""
        self.last_ping = time.time()
    
    def add_send_data(self, data: bytes):
        """Add data to send buffer."""
        # Split into chunks if needed
        for i in range(0, len(data), MAX_CHUNK_SIZE):
            chunk = data[i:i+MAX_CHUNK_SIZE]
            self.send_buffer.append(chunk)
    
    def get_send_data(self) -> Optional[bytes]:
        """Get next data to send."""
        if self.send_buffer:
            return self.send_buffer.popleft()
        return None
    
    def add_recv_data(self, data: bytes):
        """Add received data to buffer."""
        self.recv_buffer.append(data)
    
    def get_recv_data(self) -> Optional[bytes]:
        """Get next received data."""
        if self.recv_buffer:
            return self.recv_buffer.popleft()
        return None


class TCPTunnelServer:
    """
    Local TCP server that accepts raw TCP connections and tunnels them
    through Google Apps Script or Cloudflare Worker via HTTP/WebSocket.
    
    Supports multiple modes:
    - Apps Script: HTTP polling (slow but works everywhere)
    - Cloudflare: WebSocket (faster, better for video/throughput)
    - VPS: Direct TCP (fastest, requires exit node)
    """
    
    def __init__(self, listen_host: str, listen_port: int, 
                 domain_fronter, config: dict):
        """
        Args:
            listen_host: Address to listen on (e.g., "127.0.0.1")
            listen_port: Port to listen on (e.g., 1080)
            domain_fronter: DomainFronter instance for HTTP relay
            config: Configuration dict with tunnel settings
        """
        self.listen_host = listen_host
        self.listen_port = listen_port
        self.fronter = domain_fronter
        self.config = config
        
        # Tunnel registry: tunnel_id → TunnelState
        self.tunnels: Dict[str, TunnelState] = {}
        self.tunnels_lock = asyncio.Lock()
        
        # Exit node mode
        tunnel_cfg = config.get("tcp_tunnel", {})
        mode_str = tunnel_cfg.get("mode", "apps_script").lower()
        try:
            # Try direct enum match first
            self.mode = TunnelMode(mode_str)
        except ValueError:
            # Fallback to default
            self.mode = TunnelMode.GOOGLE_APPS_SCRIPT
            log.warning(f"Invalid mode '{mode_str}', using apps_script")
        
        self.server = None
        self._running = False
        
        # Statistics
        self.stats = {
            "total_tunnels": 0,
            "active_tunnels": 0,
            "bytes_sent": 0,
            "bytes_received": 0,
            "errors": 0,
        }
    
    async def start(self):
        """Start listening for TCP connections."""
        self.server = await asyncio.start_server(
            self._handle_client,
            self.listen_host,
            self.listen_port
        )
        self._running = True
        log.info(
            f"TCP Tunnel listening on {self.listen_host}:{self.listen_port} "
            f"[Mode: {self.mode.value}]"
        )
        
        # Start background tasks
        asyncio.create_task(self._cleanup_expired_tunnels())
        asyncio.create_task(self._keep_alive_pinger())
        
        async with self.server:
            await self.server.serve_forever()
    
    async def stop(self):
        """Stop the server."""
        self._running = False
        if self.server:
            self.server.close()
    
    async def _handle_client(self, reader: asyncio.StreamReader,
                            writer: asyncio.StreamWriter):
        """
        Handle a new TCP client connection.
        
        1. Read initial bytes to detect protocol & target
        2. Create tunnel in backend (Apps Script/Cloudflare)
        3. Start polling/relay loop for bi-directional exchange
        """
        peer_addr = writer.get_extra_info('peername')
        tunnel_id = str(uuid.uuid4())
        
        log.debug(f"[{tunnel_id}] New client from {peer_addr}")
        
        try:
            # Read first chunk from client (protocol detection)
            # Use read() with timeout instead of readexactly() to get whatever is available
            initial_data = await asyncio.wait_for(
                reader.read(1024),
                timeout=5.0
            )
            if not initial_data:
                return
            
            # Detect protocol and target
            protocol = self._detect_protocol(initial_data)
            target_host, target_port = self._extract_target(protocol, initial_data)
            
            log.info(
                f"[{tunnel_id}] Protocol: {protocol}, "
                f"Target: {target_host}:{target_port} (Mode: {self.mode.value})"
            )
            
            # Create tunnel state
            tunnel = TunnelState(
                tunnel_id=tunnel_id,
                target_host=target_host,
                target_port=target_port,
                created_at=time.time(),
                last_activity=time.time(),
                last_ping=time.time(),
                mode=self.mode,
            )
            
            async with self.tunnels_lock:
                self.tunnels[tunnel_id] = tunnel
                self.stats["total_tunnels"] += 1
                self.stats["active_tunnels"] = len(self.tunnels)
            
            # Send initial data to server
            tunnel.add_send_data(initial_data)
            
            # Start relay loop (mode-dependent)
            if self.mode == TunnelMode.CLOUDFLARE_WEBSOCKET:
                await self._websocket_relay_loop(tunnel_id, reader, writer)
            else:
                await self._polling_relay_loop(tunnel_id, reader, writer)
            
        except asyncio.TimeoutError:
            log.warning(f"[{tunnel_id}] Timeout waiting for initial data")
            self.stats["errors"] += 1
        except Exception as e:
            log.error(f"[{tunnel_id}] Error: {e}")
            self.stats["errors"] += 1
        finally:
            async with self.tunnels_lock:
                self.tunnels.pop(tunnel_id, None)
                self.stats["active_tunnels"] = len(self.tunnels)
            writer.close()
            await writer.wait_closed()
            log.debug(f"[{tunnel_id}] Connection closed")
    
    async def _polling_relay_loop(self, tunnel_id: str,
                                 reader: asyncio.StreamReader,
                                 writer: asyncio.StreamWriter):
        """
        Main polling loop (for Apps Script mode):
        1. Read client → buffer
        2. POST to Apps Script
        3. Receive response
        4. Write to client
        5. Repeat every 50ms
        """
        tunnel = self.tunnels[tunnel_id]
        
        while self._running and tunnel_id in self.tunnels:
            try:
                # 1. Receive data from client (non-blocking)
                try:
                    chunk = await asyncio.wait_for(
                        reader.read(MAX_CHUNK_SIZE),
                        timeout=POLL_INTERVAL * 0.5
                    )
                    if chunk:
                        tunnel.add_send_data(chunk)
                        tunnel.update_activity()
                    elif chunk == b'':  # EOF
                        tunnel.closed = True
                except asyncio.TimeoutError:
                    pass
                
                # 2. Send buffered data to relay
                send_data = tunnel.get_send_data()
                if send_data or tunnel.needs_ping(time.time()):
                    recv_data = await self._relay_chunk(tunnel, send_data)
                    if recv_data:
                        tunnel.add_recv_data(recv_data)
                        tunnel.update_activity()
                    tunnel.update_ping()
                
                # 3. Send buffered data to client
                recv_data = tunnel.get_recv_data()
                if recv_data:
                    writer.write(recv_data)
                    await writer.drain()
                    tunnel.update_activity()
                    self.stats["bytes_received"] += len(recv_data)
                
                # 4. Check for tunnel closure
                if tunnel.closed and not tunnel.send_buffer:
                    break
                
                # 5. Sleep briefly to prevent busy-loop
                await asyncio.sleep(POLL_INTERVAL)
                
            except ConnectionResetError:
                log.debug(f"[{tunnel_id}] Connection reset")
                break
            except Exception as e:
                log.error(f"[{tunnel_id}] Polling error: {e}")
                self.stats["errors"] += 1
                break
    
    async def _websocket_relay_loop(self, tunnel_id: str,
                                   reader: asyncio.StreamReader,
                                   writer: asyncio.StreamWriter):
        """
        Main relay loop (for Cloudflare WebSocket mode):
        Similar to polling but optimized for WebSocket async model.
        Relies on Cloudflare Worker maintaining persistent connection.
        """
        tunnel = self.tunnels[tunnel_id]
        
        # Establish WebSocket connection to Cloudflare Worker
        try:
            ws_connection = await self._create_websocket_connection(tunnel)
        except Exception as e:
            log.error(f"[{tunnel_id}] Failed to establish WebSocket: {e}")
            self.stats["errors"] += 1
            return
        
        try:
            # Start sender & receiver tasks
            sender_task = asyncio.create_task(
                self._ws_sender(tunnel_id, tunnel, reader, ws_connection)
            )
            receiver_task = asyncio.create_task(
                self._ws_receiver(tunnel_id, tunnel, writer, ws_connection)
            )
            
            # Wait for either to complete
            done, pending = await asyncio.wait(
                [sender_task, receiver_task],
                return_when=asyncio.FIRST_EXCEPTION
            )
            
            for task in pending:
                task.cancel()
            
            for task in done:
                # Re-raise any exceptions
                task.result()
        
        finally:
            # Close WebSocket
            if ws_connection:
                await ws_connection.close()
    
    async def _relay_chunk(self, tunnel: TunnelState,
                          send_data: Optional[bytes]) -> Optional[bytes]:
        """
        Send chunk to Apps Script and receive response (polling mode).
        Uses domain fronter's relay_tcp_tunnel() method.
        """
        try:
            tunnel.seq_send += 1
            tunnel.last_activity = time.time()
            
            # Use domain fronter to send HTTP POST to Apps Script
            # relay_tcp_tunnel(tunnel_id, target_host, target_port, data)
            response_data = await self.fronter.relay_tcp_tunnel(
                tunnel.tunnel_id,
                tunnel.target_host,
                tunnel.target_port,
                send_data or b''
            )
            
            if response_data:
                self.stats["bytes_sent"] += len(send_data or b'')
                self.stats["bytes_received"] += len(response_data)
                return response_data
            
            return None
        
        except Exception as e:
            log.error(f"[{tunnel.tunnel_id}] Relay failed: {e}")
            self.stats["errors"] += 1
            return None
    
    async def _create_websocket_connection(self, tunnel: TunnelState):
        """
        Establish WebSocket connection to Cloudflare Worker.
        Handles Cloudflare-specific headers and connection setup.
        
        Requires: pip install websockets
        """
        try:
            import websockets
        except ImportError:
            raise RuntimeError(
                "WebSocket relay requires 'websockets' package. "
                "Install with: pip install websockets"
            )
        
        # Get Cloudflare Worker URL from config
        cf_config = self.config.get("cloudflare_worker", {})
        worker_url = cf_config.get("websocket_url")
        auth_token = cf_config.get("auth_token")
        
        if not worker_url:
            raise ValueError("Cloudflare Worker WebSocket URL not configured")
        
        # Build WebSocket URL with tunnel info
        ws_url = (
            f"{worker_url}?tunnel_id={tunnel.tunnel_id}"
            f"&host={tunnel.target_host}&port={tunnel.target_port}"
        )
        
        headers = {}
        if auth_token:
            headers["Authorization"] = f"Bearer {auth_token}"
        
        try:
            # Connect with timeout
            ws = await asyncio.wait_for(
                websockets.connect(ws_url, extra_headers=headers),
                timeout=10.0
            )
            log.debug(f"[{tunnel.tunnel_id}] WebSocket connected")
            return ws
        
        except asyncio.TimeoutError:
            raise RuntimeError("WebSocket connection timeout")
    
    async def _ws_sender(self, tunnel_id: str, tunnel: TunnelState,
                        reader: asyncio.StreamReader, ws):
        """Send data from client to WebSocket (and then target server)."""
        try:
            while self._running and tunnel_id in self.tunnels:
                try:
                    # Read from client (non-blocking, short timeout)
                    chunk = await asyncio.wait_for(
                        reader.read(MAX_CHUNK_SIZE),
                        timeout=1.0
                    )
                    
                    if not chunk:  # EOF
                        await ws.send(json.dumps({"type": "close"}))
                        break
                    
                    # Send to Cloudflare Worker as binary
                    await ws.send(chunk)
                    tunnel.update_activity()
                    self.stats["bytes_sent"] += len(chunk)
                
                except asyncio.TimeoutError:
                    # Send keep-alive ping periodically
                    if tunnel.needs_ping(time.time()):
                        await ws.send(json.dumps({"type": "ping"}))
                        tunnel.update_ping()
        
        except Exception as e:
            log.debug(f"[{tunnel_id}] Sender error: {e}")
    
    async def _ws_receiver(self, tunnel_id: str, tunnel: TunnelState,
                          writer: asyncio.StreamWriter, ws):
        """Receive data from WebSocket and send to client."""
        try:
            async for message in ws:
                if isinstance(message, str):
                    # JSON message (control frames)
                    msg_obj = json.loads(message)
                    if msg_obj.get("type") == "close":
                        break
                else:
                    # Binary message (TCP data)
                    writer.write(message)
                    await writer.drain()
                    tunnel.update_activity()
                    self.stats["bytes_received"] += len(message)
        
        except Exception as e:
            log.debug(f"[{tunnel_id}] Receiver error: {e}")
    
    def _detect_protocol(self, data: bytes) -> str:
        """Detect protocol from initial bytes."""
        if len(data) == 0:
            return "UNKNOWN"
        
        if data.startswith(b'SSH-'):
            return 'SSH'
        elif len(data) >= 2 and data[0:1] == b'\x16' and data[1:2] in (b'\x03',):
            return 'TLS'
        elif len(data) > 0 and data[0:1].isdigit():
            return 'SMTP'
        elif len(data) > 2 and data[0:3] == b'\x00\x01\x00':
            return 'DNS'
        else:
            return 'UNKNOWN'
    
    def _extract_target(self, protocol: str, data: bytes = None) -> Tuple[str, int]:
        """
        Extract target host and port based on protocol.
        
        For now, use configuration defaults. In future, could use SOCKS5
        headers or other protocol-specific methods.
        """
        tcp_cfg = self.config.get("tcp_tunnel", {})
        ports = tcp_cfg.get("protocol_ports", {})
        
        default_ports = {
            'SSH': ('127.0.0.1', 22),
            'SMTP': ('127.0.0.1', 25),
            'DNS': ('8.8.8.8', 53),
            'TLS': ('127.0.0.1', 443),
            'UNKNOWN': ('127.0.0.1', 80),
        }
        
        # Allow per-protocol configuration
        if protocol in ports:
            port = ports[protocol]
            # Could be {"host": "x", "port": y} or just port number
            if isinstance(port, dict):
                return (port.get("host", "127.0.0.1"), port.get("port", 80))
            else:
                return ("127.0.0.1", port)
        
        return default_ports.get(protocol, ('127.0.0.1', 80))
    
    async def _cleanup_expired_tunnels(self):
        """Periodically clean up idle tunnels."""
        while self._running:
            try:
                await asyncio.sleep(60)  # Check every 60 seconds
                now = time.time()
                
                async with self.tunnels_lock:
                    expired = [
                        tid for tid, tunnel in self.tunnels.items()
                        if tunnel.is_expired(now)
                    ]
                    for tid in expired:
                        del self.tunnels[tid]
                        log.info(f"Cleaned up expired tunnel {tid}")
                
                self.stats["active_tunnels"] = len(self.tunnels)
            
            except Exception as e:
                log.error(f"Cleanup error: {e}")
    
    async def _keep_alive_pinger(self):
        """Send periodic keep-alive pings to tunnels."""
        while self._running:
            try:
                await asyncio.sleep(PING_INTERVAL)
                now = time.time()
                
                async with self.tunnels_lock:
                    for tunnel in self.tunnels.values():
                        if tunnel.needs_ping(now) and tunnel.mode == TunnelMode.GOOGLE_APPS_SCRIPT:
                            # Queue a ping (empty send)
                            tunnel.add_send_data(b'')
            
            except Exception as e:
                log.error(f"Pinger error: {e}")
    
    def get_stats(self) -> dict:
        """Get tunnel statistics."""
        return self.stats.copy()


def create_tunnel_server(config: dict, domain_fronter) -> TCPTunnelServer:
    """Factory function to create TCP tunnel server from config."""
    tcp_cfg = config.get("tcp_tunnel", {})
    host = tcp_cfg.get("listen_host", "127.0.0.1")
    port = tcp_cfg.get("listen_port", 1080)
    return TCPTunnelServer(host, port, domain_fronter, config)
