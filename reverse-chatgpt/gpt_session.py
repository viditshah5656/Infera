from curl_cffi import requests
from build import getToken, solve_sentinel_challenge,getConfig
from utils import get_build_number
from uuid import uuid4
import json
from collections import defaultdict
from tunsile import *

class Session:
    
    def __init__(self,**kwargs):
        self.token = kwargs.get("token",None)
        self.device_id = str(uuid4())
        self.build_number = None
        self.session = requests.Session(impersonate="chrome")
        self.sentinel = defaultdict(str)
        self.requirement_token = None
        self.init()
        
    
    def init(self):
        response = self.session.get("https://chatgpt.com")    
        self.build_number = get_build_number(response.text)
        self.requirement_token = getToken(self.build_number)
        self.get_requirements()
       
    
    
    def get_requirements(self):
         
        # Step 3: Use the same session to send a POST request
        post_url = "https://chatgpt.com/backend-anon/sentinel/chat-requirements"

        # Example payload — replace with your actual data
        payload = {
          "p": self.requirement_token
        }

        headers = {
            'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.5',
            # 'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Referer': 'https://chatgpt.com/',
            'OAI-Language': 'en-US',
            'OAI-Device-Id': self.device_id,
            'OAI-Client-Version': self.build_number,
            'Content-Type': 'application/json',
            'Origin': 'https://chatgpt.com',
            'DNT': '1',
            'Sec-GPC': '1',
            'Connection': 'keep-alive',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Priority': 'u=0',
            # Requests doesn't support trailers
            # 'TE': 'trailers',
        }
        
        #print("requirements header",headers)

        # # Send POST request with session cookies and headers
        post_response = self.session.post(post_url, headers=headers,json=payload)
        #print("POST status:", post_response.status_code)
        data = post_response.json()
            
        self.requirements = post_response.json()
        
        self.sentinel["token"] = data.get('token')
          
        turnstile = data.get('turnstile', {})
        turnstile_required = turnstile.get('required')
        pow_conf = data.get('proofofwork', {})
        
       
        if turnstile_required:
            turnstile_dx = turnstile.get('dx')
            turnstile_token = process_turnstile(turnstile_dx, self.requirement_token)
            #print("Turnsile token",turnstile_token)
            self.sentinel["turnstile"] = turnstile_token
        
        config = getConfig(self.build_number)
        self.sentinel["proof"] = get_answer_token(pow_conf.get('seed'), pow_conf.get('difficulty'), config)
        
        
