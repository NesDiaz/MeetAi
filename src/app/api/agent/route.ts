export const config = {
    runtime: "edge",
  };
  
  export default function handler(req: Request): Response {
    if (req.method !== "GET") {
      return new Response("Only GET allowed", { status: 405 });
    }
  
    const upgrade = req.headers.get("upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }
  
    // Upgrade Stream → our Edge function
    interface WebSocketRequest extends Request {
        webSocketUpgrade: () => {
          socket: WebSocket;
          response: Response;
        };
      }
      
      const { socket: streamSocket, response } =
        (req as WebSocketRequest).webSocketUpgrade();
      
      // Connect to OpenAI Realtime
    const openaiSocket = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview&api_key=${process.env.OPENAI_API_KEY}`
    );
  
    // Forward OpenAI → Stream
    openaiSocket.onmessage = (msg: MessageEvent) => {
      try {
        streamSocket.send(msg.data);
      } catch (e) {
        console.error("Forward OpenAI → Stream failed:", e);
      }
    };
  
    // Forward Stream → OpenAI
    streamSocket.onmessage = (msg: MessageEvent) => {
      try {
        openaiSocket.send(msg.data);
      } catch (e) {
        console.error("Forward Stream → OpenAI failed:", e);
      }
    };
  
    // Log errors
    openaiSocket.onerror = (err: Event) => {
      console.error("OpenAI WS Error:", err);
    };
  
    streamSocket.onerror = (err: Event) => {
      console.error("Stream WS Error:", err);
    };
  
    // Close both sides
    openaiSocket.onclose = () => {
      try {
        streamSocket.close();
      } catch {}
    };
  
    streamSocket.onclose = () => {
      try {
        openaiSocket.close();
      } catch {}
    };
  
    return response;
  }
  