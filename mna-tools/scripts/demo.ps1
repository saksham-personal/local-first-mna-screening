param(
    [string]$BaseUrl = 'http://127.0.0.1:7318',
    [Parameter(Mandatory)][string]$ApiKey,
    [Parameter(Mandatory)][string]$AnalystKey
)
$ErrorActionPreference = 'Stop'
$serviceHeaders = @{ Authorization = "Bearer $ApiKey" }
$analystHeaders = @{ Authorization = "Bearer $ApiKey"; 'X-MNA-Analyst-Key' = $AnalystKey }
function Invoke-Mna([string]$Path, $Body, [bool]$Admin = $false) {
    $headers = if ($Admin) { $analystHeaders } else { $serviceHeaders }
    Invoke-RestMethod -Method Post -Uri "$BaseUrl$Path" -Headers $headers -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 30 -Compress)
}
$companies = @(
    @{ company_id='DEMO-C1'; name='Carrier Cloud'; country='India'; industry='Insurance Software'; description='Policy administration SaaS for insurance carriers'; embedding=@(1.0,0.0,0.0) },
    @{ company_id='DEMO-C2'; name='Claims Suite'; country='India'; description='Claims workflow software for insurers'; embedding=@(0.95,0.05,0.0) },
    @{ company_id='DEMO-C3'; name='Generic Services'; country='USA'; industry='IT Consulting'; description='Generic technology consulting'; embedding=@(0.0,1.0,0.0) }
)
Invoke-Mna '/admin/companies' @{ companies=$companies } $true | Out-Null
$createdRun = Invoke-Mna '/admin/runs' @{ objective='Find insurance software businesses'; original_criteria=@{ geography=@('India'); software_core=$true }; initial_profile=@{ core_business_query='insurance policy and claims software'; core_business_criteria=@('Own insurer workflow software'); unused_criteria=@(@{ criterion='India'; reason='Geography is recorded but not used for discovery' }) } } $true
$runId = $createdRun.run_id
Invoke-Mna '/admin/profiles/approve' @{ run_id=$runId; version=1; approved_by='fictional demo analyst' } $true | Out-Null
$search = Invoke-Mna '/tools/search-companies' @{ run_id=$runId; query='insurance OR insurers'; mode='lexical'; filters=@{ country=@('India') }; limit=10; prefer_meilisearch=$false }
$candidateIds = @($search.results | ForEach-Object { $_.company.company_id })
Invoke-Mna '/tools/add-candidates' @{ run_id=$runId; companies=$candidateIds; discovery_source='SQLITE_LOCAL'; query_id=$search.query_id } | Out-Null
Invoke-Mna '/tools/save-evidence' @{ run_id=$runId; company_id='DEMO-C1'; claim='customer_segment'; value='Insurance carriers'; source_type='analyst'; source_reference='Fictional demonstration'; confidence='high' } | Out-Null
Invoke-Mna '/admin/labels' @{ run_id=$runId; company_id='DEMO-C1'; label='BEST_FIT'; analyst_note='Core vertical SaaS product' } $true | Out-Null
$proposal = Invoke-Mna '/tools/propose-screening-profile' @{ run_id=$runId; content=@{ core_business_query='insurance vertical SaaS policy administration'; core_business_criteria=@('Own policy software product'); unused_criteria=@(@{ criterion='India'; reason='Not used for discovery' }) }; rationale='Demonstration analyst feedback'; supporting_example_ids=@('DEMO-C1') }
Invoke-Mna '/admin/profiles/approve' @{ run_id=$runId; version=$proposal.version; approved_by='demo analyst' } $true | Out-Null
$packet = Invoke-Mna '/tools/build-context-packet' @{ run_id=$runId; task_type='SCREEN_CANDIDATES'; subject_ids=$candidateIds; token_budget=12000 }
[pscustomobject]@{ run_id=$runId; candidates=$candidateIds.Count; profile_version=$proposal.version; context_bytes=$packet.metadata.serialized_bytes; omitted=$packet.metadata.omitted } | ConvertTo-Json -Depth 5
