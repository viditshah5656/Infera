
import time
import random
from bs4 import BeautifulSoup
from utils import load_config,get_build_number,format_wat_time
from datetime import datetime
import uuid
import json
import base64
import hashlib


def zi(e): 
    return e[random.randint(0, len(e) - 1)]

def zT():
    return str(random.random())


def get_build_number(data):
    if data is not None:
        soup = BeautifulSoup(data,'lxml')
        el = soup.find("html")
        if el:
            build = el.get('data-build')
            return build
            
            

def Di(e):
    json_str = json.dumps(e)
    utf8_bytes = json_str.encode('utf-8')
    base64_str = base64.b64encode(utf8_bytes).decode('utf-8')
    return base64_str


def WT(data):
  
  v = [ x for x in data]
  e = zi(v)
  
  try:
    #return `${e}−${navigator[e].toString()}`; 
    return f"{e}-{data[e]}"
  except Exception as e:
    return e
#   try {
#     return `${e}−${navigator[e].toString()}`;
#   } catch {
#     return `${e}`;
#   }


def getConfig(buildNo):
     
    config = load_config()
    t = int(time.time())
    
    return [
        config["screen"]["width"] + config["screen"]["height"],
        format_wat_time(),
        None,
        random.random(),
        config["navigator"]["userAgent"],
        None,
        buildNo,
        config["navigator"]["language"],
        ",".join(config["navigator"]["languages"]),
        random.random(),
        WT(config["navigator"]["properties"]),
        zi(config["document"]),
        zi(config["window"]),
        int(time.perf_counter() * 1000),
        str(uuid.uuid4()),
        "",
        config["navigator"]["hardwareConcurrency"],
        t 
    ]
    
    

def getToken(buildNo):
    return "gAAAAAC" + _generate_requirements_token_answer_blocking(buildNo)



def Di(e):
    # Step 1: Convert to JSON string
    json_str = json.dumps(e)

    # Step 2: Encode as UTF-8 bytes
    utf8_bytes = json_str.encode('utf-8')

    # Step 3: Base64 encode
    base64_str = base64.b64encode(utf8_bytes).decode('ascii')

    return base64_str

def _generate_requirements_token_answer_blocking(buildNo):
    t = "e"
    start = int(time.perf_counter() * 1000)  # Convert to milliseconds
    try:
        n = getConfig(buildNo)
        #print(f"config is {n}")
        n[3] = 1
        n[9] = round((int(time.perf_counter() * 1000)) - start)
        return Di(n)
    except Exception as err:
        print("Error",err)
        t = Di(str(err))
    return "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + t




def solve_sentinel_challenge(seed, difficulty):
    
    config = load_config()
    
    cores = [8, 12, 16, 24]
    
    core = random.choice(cores)
    screen = config["screen"]["width"]

    parse_time = format_wat_time()

    config = [core + screen, parse_time, 4294705152, 0, config["navigator"]["hardwareConcurrency"]]

    diff_len = len(difficulty) // 2

    for i in range(100000):
        config[3] = i
        json_data = str(config).replace("'", '"')
        base = base64.b64encode(json_data.encode()).decode()
        hash_value = hashlib.sha3_512((seed + base).encode()).hexdigest()

        if hash_value[:diff_len] <= difficulty:
            return "gAAAAAB" + base

    fallback_base = base64.b64encode(f'"{seed}"'.encode()).decode()
    return "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + fallback_base

# token = getToken()

# print(token)

# config = load_config()

# v = [ x for x in config["navigator"]["properties"]]

# print(v)

