# Read only. Requests drive reads; no focus, input, clipboard or desktop writes.
param([switch]$Serve)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PanelContextWindows {
  private delegate bool Callback(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback c, IntPtr l);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public static IntPtr[] Handles(int[] processIds) {
    var allowed=new HashSet<int>(processIds);var found=new List<IntPtr>();
    EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(allowed.Contains((int)p)&&IsWindowVisible(h))found.Add(h);return true;},IntPtr.Zero);
    return found.ToArray();
  }
}
'@
function Test-SelectedSidebarClass([string]$className) {
    $classes=$className -split '\s+'
    return ($classes -ccontains 'sidebar-item') -and (
        ($classes -ccontains 'bg-primary-ghost-hover') -or
        (($classes -ccontains 'bg-secondary-ghost-hover') -and
         ($classes -ccontains 'data-[app-action-sidebar-thread-selected=true]:bg-secondary-ghost-hover'))
    )
}
$script:relations=@();$script:labelKey=''
function Read-Context($inputData){
    $labelKey=(@($inputData.projectLabels | Sort-Object) | ConvertTo-Json -Compress)
    if($labelKey -cne $script:labelKey){$script:relations=@();$script:labelKey=$labelKey}
$result=@{status='outside';matched=$false}
$stats=@{lightChecks=1;fullScans=0;invalidations=0}
try {
    $docCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Document)
    $buttonCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
    $editCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)
    function Named-Condition($typeCondition,$names) {
        $conditions=[System.Windows.Automation.Condition[]]@($names | ForEach-Object {[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,[string]$_)})
        if($conditions.Count -eq 0){return $null}
        $nameCondition=if($conditions.Count -eq 1){$conditions[0]}else{[System.Windows.Automation.OrCondition]::new($conditions)}
        return [System.Windows.Automation.AndCondition]::new($typeCondition,$nameCondition)
    }
    $composerNames=@('与 Codex 协作','和 Codex 一起工作','Collaborate with Codex','Work with Codex')
    $composerCondition=Named-Condition $editCondition $composerNames
    $projectCondition=Named-Condition $buttonCondition @($inputData.projectLabels)
    $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
    function Value-Of($element) {
        $pattern=$null
        if($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){return $pattern.Current.Value}
        return ''
    }
    function Document-Of($element) {
        $parent=$walker.GetParent($element)
        while($parent -and $parent.Current.ControlType -ne [System.Windows.Automation.ControlType]::Document){$parent=$walker.GetParent($parent)}
        return $parent
    }
    function Test-SelectedSidebarItem($element,$title) {
        return !$element.Current.IsOffscreen -and $element.Current.Name -ceq $title -and
            (Test-SelectedSidebarClass $element.Current.ClassName) -and
            (Value-Of (Document-Of $element)) -like 'app://*'
    }
    $processes=@(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue)
    $windowMatches=@(foreach($handle in [PanelContextWindows]::Handles(@($processes | ForEach-Object Id))) {
        $root=[System.Windows.Automation.AutomationElement]::FromHandle($handle)
        if($root.Current.IsOffscreen){continue}
        $documents=@($root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$docCondition) | Where-Object {-not $_.Current.IsOffscreen})
        $boards=@($documents | Where-Object {
            $value=Value-Of $_
            if($inputData.snapshot -eq $true){try{$uri=[Uri]$value;return $uri.GetLeftPart([UriPartial]::Authority) -eq $inputData.origin -and $uri.AbsolutePath -eq '/'}catch{return $false}}
            return $value -eq $inputData.pageUrl
        })
        if($boards.Count -eq 0){continue}
        $apps=@($documents | Where-Object {(Value-Of $_) -like 'app://*'})
        $process=$processes | Where-Object Id -eq $root.Current.ProcessId | Select-Object -First 1
        $hostVersion=''
        try {
            if($process.Path -match '[\\/]OpenAI\.Codex_(\d+(?:\.\d+){1,3})_'){$hostVersion=$Matches[1]}
            elseif($process.FileVersion -match '^\d+(?:\.\d+){1,3}$'){$hostVersion=$process.FileVersion}
        } catch {}
        @{boards=$boards;apps=$apps;window=$handle;hostVersion=$hostVersion}
    })
    if($windowMatches.Count -gt 0){$result=@{status='unresolved';matched=$true;reason='当前窗口或侧栏归属不唯一'}}
    function Read-WindowObservation($target,$pageUrl) {
        $stats.fullScans++
        $result=@{status='unresolved';matched=$true}
        $app=$target.apps[0];$title=$app.Current.Name
        $labels=@();$labelElements=@();$ownerLabels=@();$selected=@();$ownerList=$null;$ownerName=''
        $titleCondition=Named-Condition $buttonCondition @($title)
        $selected=@($app.FindAll([System.Windows.Automation.TreeScope]::Descendants,$titleCondition) | Where-Object {
            Test-SelectedSidebarItem $_ $title
        })
        if($selected.Count -eq 1){
            $parent=$selected[0]
            for($depth=0;$depth -lt 8;$depth++){
                $parent=$walker.GetParent($parent)
                if(-not $parent -or $parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document){break}
                if($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::List -and $parent.Current.Name -match '^(.+)中的已安排任务$'){
                    $ownerLabels=@($Matches[1]);$ownerList=$parent;$ownerName=$parent.Current.Name;break
                }
            }
        }elseif($selected.Count -gt 1){return @{status='unresolved';matched=$true;reason='当前侧栏选择不唯一'}}
        $editors=@($app.FindAll([System.Windows.Automation.TreeScope]::Descendants,$composerCondition) | Where-Object {
            -not $_.Current.IsOffscreen -and $_.Current.ClassName -match '^ProseMirror( |$)' -and
            $_.Current.Name -in $composerNames -and
            (Value-Of (Document-Of $_)) -like 'app://*'
        })
        if($editors.Count -eq 1 -and $projectCondition){
            $rect=$editors[0].Current.BoundingRectangle;$parent=$editors[0]
            for($depth=0;$depth -lt 6;$depth++){
                $parent=$walker.GetParent($parent)
                if(-not $parent -or $parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document){break}
                $labelElements+=@($parent.FindAll([System.Windows.Automation.TreeScope]::Descendants,$projectCondition) | Where-Object {
                    $box=$_.Current.BoundingRectangle
                    -not $_.Current.IsOffscreen -and $_.Current.Name -in $inputData.projectLabels -and
                    $box.Top -lt $rect.Top -and $box.Top -ge $rect.Top-100 -and
                    $box.Left -ge $rect.Left-40 -and $box.Right -le $rect.Right+40 -and
                    (Value-Of (Document-Of $_)) -like 'app://*'
                })
            }
        }
        $labels=@($labelElements | ForEach-Object {$_.Current.Name} | Select-Object -Unique)
        # A composer project picker is present on the uncreated chat home.
        # Never infer a project from sidebar labels or message text.
        $selectionStable=$selected.Count -eq 0 -or ($selected.Count -eq 1 -and (Test-SelectedSidebarItem $selected[0] $title))
        if($ownerList -and $ownerList.Current.Name -cne $ownerName){$selectionStable=$false}
        if(!$selectionStable){
            $result=if($selected.Count -gt 1){@{status='unresolved';matched=$true;reason='当前聊天选择不唯一'}}else{@{status='unresolved';matched=$true;retryableContext=$true}}
        }
        if($selectionStable -and $app.Current.Name -ceq $title -and (Value-Of $target.boards[0]) -eq $pageUrl){
            $rowId=if($selected.Count -eq 1){$selected[0].GetRuntimeId() -join '.'}else{''}
            $identity=([string]$target.window)+'|'+($app.GetRuntimeId() -join '.')+'|'+$rowId+'|'+(@($labelElements | ForEach-Object {$_.GetRuntimeId() -join '.'} | Select-Object -Unique) -join ',')
            $result=@{status='observed';matched=$true;title=$title;draftLabels=$labels;ownerLabels=$ownerLabels;windowId=[string]$target.window;identityKey=$identity;selectedRowId=$rowId;pageUrl=$pageUrl}
            $namedThread=$labels.Count -eq 0 -and $editors.Count -eq 1 -and $title -cnotin @('ChatGPT','Codex','New chat','New conversation','New task','Home','Chat','Tasks','新对话','新聊天','新任务','主页','聊天','任务') -and $title -cnotin $inputData.projectLabels
            if(($selected.Count -eq 1 -and $ownerList) -or ($selected.Count -eq 0 -and $labels.Count -eq 1 -and $editors.Count -eq 1) -or $namedThread){
                $entry=@{window=$target.window;app=$app;title=$title;selected=$selected;ownerList=$ownerList;ownerName=$ownerName;labelElements=$labelElements;labels=$labels;editor=if($editors.Count -eq 1){$editors[0]}else{$null};observation=$result}
                $script:relations=@($script:relations | Where-Object {$_.observation.identityKey -ne $identity})+@($entry)
                if($script:relations.Count -gt 32){$script:relations=@($script:relations | Select-Object -Last 32)}
            }
        }
        return $result
    }
    function Read-KnownObservation($target,$pageUrl) {
        if($inputData.force -ne $true){
            $known=@($script:relations | Where-Object {$_.window -eq $target.window})
            foreach($entry in $known){try{
                $app=$target.apps[0]
                if(($entry.app.GetRuntimeId() -join '.') -ne ($app.GetRuntimeId() -join '.') -or $app.Current.Name -cne $entry.title){continue}
                if($entry.selected.Count -eq 1){
                    $selected=$entry.selected[0]
                    if(!(Test-SelectedSidebarItem $selected $entry.title)){continue}
                    if($entry.ownerList){
                    if($entry.ownerList.Current.Name -cne $entry.ownerName){continue}
                    $parent=$selected;$sameOwner=$false
                    for($depth=0;$depth -lt 8;$depth++){
                        $parent=$walker.GetParent($parent)
                        if(!$parent -or $parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document){break}
                        if($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::List -and $parent.Current.Name -match '^(.+)中的已安排任务$'){
                            $sameOwner=($parent.Current.Name -ceq $entry.ownerName) -and (($parent.GetRuntimeId() -join '.') -ceq ($entry.ownerList.GetRuntimeId() -join '.'));break
                        }
                    }
                    if(!$sameOwner){continue}
                    }
                }else{
                    if(!$entry.editor -or $entry.editor.Current.IsOffscreen){continue}
                    $selected=@($app.FindAll([System.Windows.Automation.TreeScope]::Descendants,(Named-Condition $buttonCondition @($entry.title))) | Where-Object {Test-SelectedSidebarItem $_ $entry.title})
                    if($selected.Count -ne 0){continue}
                }
                $valid=$true
                foreach($element in $entry.labelElements){
                    if($element.Current.IsOffscreen -or $element.Current.Name -cnotin $entry.labels){$valid=$false;break}
                    $rect=$entry.editor.Current.BoundingRectangle;$box=$element.Current.BoundingRectangle
                    if($box.Top -ge $rect.Top -or $box.Top -lt $rect.Top-100 -or $box.Left -lt $rect.Left-40 -or $box.Right -gt $rect.Right+40){$valid=$false;break}
                }
                if(!$valid -or $app.Current.Name -cne $entry.title -or (Value-Of $target.boards[0]) -ne $pageUrl){continue}
                return $entry.observation
            }catch{}}
            if($known.Count){$stats.invalidations++}
        }
        return Read-WindowObservation $target $pageUrl
    }
    if($inputData.snapshot -eq $true){
        $observations=@(foreach($target in $windowMatches){
            foreach($board in $target.boards){
                $pageUrl=Value-Of $board
                $observation=if($target.boards.Count -eq 1 -and $target.apps.Count -eq 1){Read-KnownObservation $target $pageUrl}else{@{status='unresolved';matched=$true;reason='当前窗口或侧栏归属不唯一'}}
                $observation.pageUrl=$pageUrl
                $observation.hostVersion=$target.hostVersion
                $observation
            }
        })
        $result=@{status='snapshot';observations=$observations}
    }elseif($windowMatches.Count -eq 1 -and $windowMatches[0].boards.Count -eq 1 -and $windowMatches[0].apps.Count -eq 1){
        $result=Read-KnownObservation $windowMatches[0] $inputData.pageUrl
    }

} catch { $result=@{status='unresolved';matched=$true;retryableContext=$true} }

$result.stats=$stats
return $result
}
if($Serve){
    while($null -ne ($line=[Console]::In.ReadLine())){
        try{$request=$line | ConvertFrom-Json;$value=Read-Context $request.input;@{id=$request.id;result=$value} | ConvertTo-Json -Compress -Depth 8}catch{@{id=$request.id;result=@{status='unresolved';matched=$true;retryableContext=$true}} | ConvertTo-Json -Compress -Depth 8}
    }
}else{Read-Context ([Console]::In.ReadToEnd() | ConvertFrom-Json) | ConvertTo-Json -Compress -Depth 8}
