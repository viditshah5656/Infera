
import json
import os
from bs4 import BeautifulSoup
from datetime import datetime
from zoneinfo import ZoneInfo
import locale
from uuid import uuid4
import random
import hashlib
import base64
from datetime import datetime, timedelta

folder_path = os.path.dirname(os.path.realpath(__file__))
config_path = os.path.join(folder_path,'config.json')
user_data_folder = f"{folder_path}/user_data"

# os.makedirs("user_data",exist_ok=True)

def load_config():

    with open(config_path,"r") as f:
        return json.load(f)


def get_build_number(data):
    if data is not None:
        soup = BeautifulSoup(data,'lxml')
        el = soup.find("html")
        if el:
            build = el.get('data-build')
            return build
            

def load_user_data(file_name):

    global user_data_folder
    file = os.path.join(user_data_folder,f"{file_name}.json")
    loaded_data = None

    if not os.path.exists(file):
       return None
    
    else:
        with open(file, 'r') as file:
            loaded_data = json.load(file)

    return loaded_data


def format_wat_time():
    
    try:
      locale.setlocale(locale.LC_TIME, 'en_US.UTF-8')
    except locale.Error:
        pass
    # West Africa Time zone
    wat = ZoneInfo("Africa/Lagos")  # Lagos is in WAT

    now = datetime.now(wat)

    date_str = now.strftime('%a %b %d %Y %H:%M:%S')

    offset = now.utcoffset()
    total_seconds = offset.total_seconds()
    sign = '+' if total_seconds >= 0 else '-'
    hours = int(abs(total_seconds) // 3600)
    minutes = int((abs(total_seconds) % 3600) // 60)

    gmt_offset = f"GMT{sign}{hours:02d}{minutes:02d}"

    # Use full timezone name manually (since tzname() will give 'WAT')
    tz_full = "West Africa Standard Time"

    return f"{date_str} {gmt_offset} ({tz_full})"


# Simulated user agent details
simulated = {
    "agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
             "AppleWebKit/537.36 (KHTML, like Gecko) "
             "Chrome/132.0.0.0 Safari/537.36",
    "platform": "Windows",
    "mobile": "?0",
    "ua": 'Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132',
}

def random_ip():
    return ".".join(str(random.randint(0, 255)) for _ in range(4))

def _random_uuid():
    return str(uuid4())

def random_float(min_val, max_val):
    return round(random.uniform(min_val, max_val), 4)

def simulate_bypass_headers(accept, spoof_address=False, pre_oai_uuid=None):
    ip = random_ip()
    uuid_val = pre_oai_uuid or _random_uuid()

    headers = {
        "accept": accept,
        "Content-Type": "application/json",
        "cache-control": "no-cache",
        "Referer": "https://chatgpt.com/",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "oai-device-id": uuid_val,
        "User-Agent": simulated["agent"],
        "pragma": "no-cache",
        "priority": "u=1, i",
        "sec-ch-ua": f'"{simulated["ua"]}"',
        "sec-ch-ua-mobile": simulated["mobile"],
        "sec-ch-ua-platform": f'"{simulated["platform"]}"',
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
    }

    if spoof_address:
        spoof_headers = {
            "X-Forwarded-For": ip,
            "X-Originating-IP": ip,
            "X-Remote-IP": ip,
            "X-Remote-Addr": ip,
            "X-Host": ip,
            "X-Forwarded-Host": ip,
        }
        headers.update(spoof_headers)

    return headers

