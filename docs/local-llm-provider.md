# Local LLM provider (`LOCAL`)

ใช้โมเดลที่ host เอง (open-weight model บนเครื่อง/เซิร์ฟเวอร์ของเรา) เป็นทางเลือกแทน
OpenRouter หรือ Gemini ได้ ทั้ง scope `USER` (ตอบลูกค้า LINE/App) และ `ADMIN`

Source: [local-llm-ai.provider.ts](../src/ai-provider/providers/local-llm-ai.provider.ts)

## ทำงานอย่างไร

- Adapter เรียก OpenAI-compatible `POST {LOCAL_LLM_BASE_URL}/chat/completions`
  ด้วย `openai` SDK ตัวเดียวกับ OpenRouter
- ใช้ได้กับ Ollama (`http://host:11434/v1`), vLLM (`http://host:8000/v1`),
  llama.cpp server, LM Studio, LocalAI หรือ gateway ที่พูด OpenAI API
- ผ่าน `AiProviderService` เดิม: retry ชั่วคราว, billing reservation/settlement,
  และ fail-safe fallback เหมือน provider อื่นทุกอย่าง
- Endpoint ตั้งโดย operator ใน env เท่านั้น ลูกค้าไม่ได้ส่ง URL เอง จึงไม่มี SSRF จาก request
- Log ไม่บันทึก URL, key หรือ body ของ error

## Env

| Key | ค่า | หมายเหตุ |
|---|---|---|
| `LOCAL_LLM_BASE_URL` | เช่น `http://10.0.0.5:11434/v1` | ต้องมี ถึงจะถือว่า configured |
| `LOCAL_LLM_API_KEY` | optional | ส่งเป็น `Bearer` (vLLM `--api-key`, reverse proxy) |
| `LOCAL_LLM_REQUEST_TIMEOUT_MS` | default `30000` | ยาวกว่า hosted API เพราะโมเดล local ช้ากว่า |
| `LOCAL_LLM_STRUCTURED_OUTPUT` | default `true` | ตั้ง `false` ถ้า server ไม่รองรับ `response_format: json_schema` |
| `AI_LOCAL_MODELS` | เช่น `qwen3:8b,llama3.1:8b` | รายการรุ่นที่ admin เลือกได้ (ไม่มี default ในโค้ด) |
| `AI_USER_PROVIDER` / `AI_USER_MODEL` | `LOCAL` / `qwen3:8b` | ถ้าอยากให้เป็นค่าเริ่มต้นของการตอบลูกค้า |

## เปิดใช้

1. รันโมเดลบน server ที่ backend เข้าถึงได้ เช่น `ollama pull qwen3:8b`
2. ตั้ง env ข้างบน แล้ว restart backend
3. สร้าง `AiModelPricing` ของ `LOCAL` + model ID ผ่าน admin pricing API
   (ต้องมี rate > 0 ไม่งั้น model ถูก block) ใช้ rate ที่ครอบคลุมค่าไฟ/เครื่อง
4. เลือก provider `Local LLM (self-hosted)` และรุ่นใน AI settings

## ข้อควรระวัง

- **Network**: อย่าเปิด port ของ Ollama/vLLM สู่ internet ตรงๆ ให้ backend คุยผ่าน
  private network, VPN (Tailscale/WireGuard) หรือ tunnel ที่มี auth
  (Cloudflare Tunnel + Access) และตั้ง `LOCAL_LLM_API_KEY` ผ่าน reverse proxy
- **Latency**: LINE reply token มีอายุราว 1 นาที โมเดลบน CPU อาจช้าเกิน
  แนะนำ GPU (8B model ~ VRAM 8–16 GB) และ `maxOutputTokens` ต่ำ
- **คุณภาพภาษาไทย / JSON**: โมเดลเล็กตอบไทยและ structured output ได้แย่กว่า
  hosted model ผลลัพธ์ทุกตัวยัง validate ฝั่ง caller และ fallback ถ้าไม่ผ่าน
  ควรรัน eval ภาษาไทยก่อนเปิดให้ลูกค้า
- **Capacity**: เครื่องเดียวรับ concurrent ได้จำกัด ถ้าเครื่องล่ม provider จะ
  fail (retryable) แล้วไปที่ safe fallback ไม่มี auto-failover ไป provider อื่น
- **Usage**: ถ้า server ไม่ส่ง `usage` กลับมา token จะเป็น 0 และไม่ถูกคิดเงิน
  (Ollama, vLLM, llama.cpp ส่งมาปกติ)
- **Embedding** ยังใช้ Gemini เหมือนเดิม adapter นี้ทำเฉพาะ text generation
