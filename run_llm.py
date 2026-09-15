# run_llm.py
import subprocess
import time
import requests
import json

def install_and_start_ollama():
    """Installs Ollama via curl script and starts the background server."""
    print("Checking for Ollama installation...")
    # Check if ollama is already installed
    ollama_check = subprocess.run(["which", "ollama"], capture_output=True, text=True)
    
    if ollama_check.returncode != 0:
        print("📥 Ollama not found. Installing Ollama inside GitHub Codespace...")
        install_cmd = "curl -fsSL https://ollama.com/install.sh | sh"
        # Run shell execution for the pipe setup
        subprocess.run(install_cmd, shell=True, check=True)
        print("✅ Ollama installation complete.")
    else:
        print("✅ Ollama is already installed.")

    # Check if the server is already running
    try:
        response = requests.get("http://localhost:11434/api/tags")
        if response.status_code == 200:
            print("🚀 Ollama server is already running.")
            return
    except requests.exceptions.ConnectionError:
        pass

    print("🚀 Starting Ollama background server...")
    # Run server as a background process redirecting output to log
    with open("ollama_server.log", "w") as log_file:
        subprocess.Popen(["ollama", "serve"], stdout=log_file, stderr=log_file)
    
    # Wait for the server to spin up
    for _ in range(10):
        try:
            response = requests.get("http://localhost:11434/api/tags")
            if response.status_code == 200:
                print("✅ Ollama server is active and responding!")
                return
        except requests.exceptions.ConnectionError:
            time.sleep(2)
            
    raise RuntimeError("❌ Failed to start the Ollama server.")

def pull_model(model_name):
    """Pulls the specified LLM model using the Ollama service."""
    print(f"📥 Pulling model '{model_name}' (this may take a few minutes depending on size)...")
    url = "http://localhost:11434/api/pull"
    payload = {"name": model_name, "stream": False}
    
    response = requests.post(url, json=payload)
    if response.status_code == 200:
        print(f"✅ Model '{model_name}' successfully loaded into memory!")
    else:
        raise RuntimeError(f"❌ Failed to pull model: {response.text}")

def generate_response(model_name, prompt):
    """Sends a text generation prompt to the locally running LLM."""
    print(f"
🧠 Thinking (Using model: {model_name})...")
    url = "http://localhost:11434/api/generate"
    payload = {
        "model": model_name,
        "prompt": prompt,
        "stream": False
    }
    
    start_time = time.time()
    response = requests.post(url, json=payload)
    end_time = time.time()
    
    if response.status_code == 200:
        result = response.json()
        print("
🤖 AI Response:")
        print(result.get("response", ""))
        print(f"
⏱️ Generation Time: {end_time - start_time:.2f} seconds")
    else:
        print(f"❌ Generation failed: {response.text}")

if __name__ == "__main__":
    # Recommended default optimized for 16GB RAM CPU-only Codespace
    DEFAULT_MODEL = "qwen2.5-coder:7b" 
    
    try:
        # Step 1: Manage background service dependencies
        install_and_start_ollama()
        
        # Step 2: Download the optimized model variant
        pull_model(DEFAULT_MODEL)
        
        # Step 3: Test standard inference pipeline
        sample_prompt = "Write a quick Python function that returns the Fibonacci sequence up to n numbers."
        generate_response(DEFAULT_MODEL, sample_prompt)
        
    except Exception as e:
        print(f"
An error occurred: {e}")
