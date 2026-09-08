from gpt_session import Session
from uuid import uuid4
import time,json
import re
from curl_cffi import Response

class ChatGPT(Session):
    SUPPORTED_MODELS = ("auto", "gpt-4o-mini", "gpt-4o")
    
    def __init__(self,**kwargs):
        self.message_handler = None
        #self.device_id = kwargs.get('device_id',None)
        self.message = kwargs.get('message',None)
        self.message_id = kwargs.get('message_id',None)
        super().__init__()
    
    def query_gpt(self):
        self.session.get()
    
    def get_chat_payload(self, text, model="auto"):
        if model not in self.SUPPORTED_MODELS:
            raise ValueError(f"Unsupported ChatGPT model: {model}")
        
        #models = [ "auto", "gpt-4o-mini", "gpt-4o", "gpt-4", "gpt-4-gizmo"]
        json_data = {
    
            "action": "next",
            "messages": [
                {
                    "id": str(uuid4()),
                    "author": { "role": "user" },
                    "create_time": time.time(),
                    "content": { "content_type": "text", "parts": [text] },
                    "metadata": { "selected_github_repos": [], "selected_all_github_repos": False, "serialization_metadata": { "custom_symbol_offsets": [] } }
                }
            ],
            "parent_message_id": "client-created-root",
            "model": model,
            "timezone_offset_min": -60,
            "timezone": "Africa/Lagos",
            "conversation_mode": { "kind": "primary_assistant" },
            "enable_message_followups": True,
            "system_hints": [],
            "supports_buffering": True,
            "supported_encodings": ["v1"],
            "client_contextual_info": { "is_dark_mode": True, "time_since_loaded": 8, "page_height": 883, "page_width": 498, "pixel_ratio": 1.0909090909090908, "screen_height": 990, "screen_width": 1760 },
            "paragen_cot_summary_display_override": "allow"
        }
        
        return json_data
    
    def get_cookies():
        return {}
    
    def get_headers(self):
        return {
        'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0',
        'Accept': 'text/event-stream',
        'Accept-Language': 'en-US,en;q=0.5',
        # 'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Referer': 'https://chatgpt.com/',
        'OAI-Language': 'en-US',
        'OAI-Device-Id': self.device_id,
        'OAI-Client-Version': self.build_number,#'prod-8018bc0b02e3620f03fac2a740e6fb888f6c58ee',
        'Content-Type': 'application/json',
        'OAI-Echo-Logs': '0,2662,1,11842,0,647956,1,658136,0,1596244,1,1639999',
        'OpenAI-Sentinel-Chat-Requirements-Token': self.sentinel.get("token"),
        #'OpenAI-Sentinel-Turnstile-Token': self.sentinel.get("turnstile"),
        'OpenAI-Sentinel-Proof-Token': self.sentinel.get("proof"),
        'Origin': 'https://chatgpt.com',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Priority': 'u=0',
        # Requests doesn't support trailers
        # 'TE': 'trailers',
    }
        

    def safe_parse(self,data_str):
        data = json.loads(data_str)
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except json.JSONDecodeError:
                pass
        return data

    @staticmethod
    def clean_output(text):
        if not isinstance(text, str):
            return text
        cleaned = re.sub(r':::writing\{[^}]*\}', '', text, flags=re.DOTALL)
        cleaned = cleaned.replace(':::', '')
        return re.sub(r'(?:cite|entity|image|link)[\s\S]*?', '', cleaned)

    def decode_stream(self, response: Response):
        buffer = ""

        for chunk in response.iter_content(chunk_size=1024):
            if not chunk:
                continue

            buffer += chunk.decode("utf-8")
            lines = buffer.split("\n")
            buffer = lines.pop()

            for line in lines:
                if line.startswith("data:"):
                    data_str = line[len("data:"):].strip()

                    if data_str == "[DONE]":
                        return

                    try:
                        data = self.safe_parse(data_str)
                    except json.JSONDecodeError:
                        continue

                    # Skip known metadata
                    if (
                        not isinstance(data, dict)
                        or "finish_details" in data
                        or data.get("type") == "message_stream_complete"
                    ):
                        continue

                    v = data.get("v")
                    if v is None:
                        continue

                    if isinstance(v, list):
                        for patch in v:
                            if isinstance(patch, dict) and patch.get("o") == "append":
                                val = patch.get("v")
                                if not isinstance(val, dict):
                                    yield self.clean_output(val)
                               

                    elif isinstance(v, str):
                        #print("finish_details v", "finish_details" in v)
                        yield self.clean_output(v)


    
    def reply_chat(self, text, model="auto"):
        
        json_data = self.get_chat_payload(text, model)
        headers = self.get_headers()
        
        response = self.session.post('https://chatgpt.com/backend-anon/conversation', headers=headers, json=json_data,stream=True,impersonate="chrome")
        
        for chunk in self.decode_stream(response):
            # print(chunk, end="", flush=True)
            yield chunk
        
       

#uvicorn app:app --host 0.0.0.0 --port 5000
