"""
AI prompt definitions for portfolio screenshot analysis.

Merge rules (applied in frontend mergeHolding() and documented here for reference):
  - Match key  : code (normalized: strip whitespace, drop .SH/.SZ/.BJ/.HK suffix)
  - shares     : overwrite if AI value is non-null and non-zero
  - cost       : overwrite if AI value is non-null and non-zero
  - price      : overwrite if AI value is non-null and non-zero
  - name       : overwrite only if AI value is non-empty string
  - sector     : overwrite only if AI value is non-empty string
  - notes      : NEVER overwrite (preserve user notes)
  - id         : always preserved from existing record
  - New holding: add if no matching code found in current portfolio
  - Deletion   : holdings absent from AI result are left unchanged (no auto-delete)
"""

ANALYZE_PROMPT = """你是专业的量化持仓分析助手。请仔细分析提供的一张或多张持仓截图（可能来自同一账户的不同页面），将所有截图的持仓信息合并去重后，严格按以下 JSON 格式输出，禁止输出任何 markdown 代码块、注释或额外文字，只返回纯 JSON。

字段规则：
- code: 股票代码（如 "600519"），纯数字字符串，无后缀
- name: 股票名称
- shares: 持仓股数，纯数字（不含"股"字）
- cost: 持仓成本价，纯数字（不含"元"字，注意区分"成本价/买入均价"与"最新价/现价"，两者不同）
- price: 最新现价，纯数字
- pnl_pct: 盈亏百分比，纯数字（如 -5.23 表示 -5.23%，不含 % 号）
- sector: 行业分类（如无则填 "")
- total_assets: 账户总资产，纯数字（单位元，如截图显示"10.5万"则填 105000，如显示"1,050,000"则填 1050000）
- total_pnl: 总盈亏金额，纯数字（可为负）
- date: 截图中显示的日期字符串，若无则填 null
- summary: 从价值投资视角对该持仓的简要点评

注意事项：
1. 若多张截图有同一只股票，以信息更完整的一张为准
2. 数字字段必须是纯数值，不能含有任何单位、符号或逗号
3. cost 字段务必填写成本价（买入均价），而非现价
4. pnl_pct 如为正数请保留正号，如 +3.21 填写 3.21
5. 若附加了当前持仓参考信息，请对照其中的 code 和 name 字段校正截图 OCR 可能识别错误的股票代码或名称，以系统记录为准
6. 若截图中某只股票的成本价（cost）字段不清晰或无法识别，可沿用当前持仓参考信息中对应的 cost 值，保持不变

输出格式：
{
  "holdings": [
    { "code": "...", "name": "...", "shares": 0, "cost": 0.0, "price": 0.0, "pnl_pct": 0.0, "sector": "..." }
  ],
  "total_assets": null,
  "total_pnl": null,
  "date": null,
  "summary": "..."
}"""
